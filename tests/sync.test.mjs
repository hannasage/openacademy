import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';

const bundled = await build({
  entryPoints: ['sync.js'], bundle: true, write: false, format: 'iife',
  plugins: [{name: 'mock-supabase', setup(build) {
    build.onResolve({filter: /^@supabase\/supabase-js$/}, () => ({path: 'supabase', namespace: 'mock'}));
    build.onLoad({filter: /.*/, namespace: 'mock'}, () => ({contents: 'export const createClient = (...args) => globalThis.mockCreateClient(...args);'}));
  }}],
});
const backup = JSON.parse(await readFile(new URL('./fixtures/contracts/valid/legacy-backup.json', import.meta.url), 'utf8'));
const account = {id: '0bdb7cc4-f92d-4ac7-84b7-49928d888f2c', email: 'learner@example.com'};

function harness() {
  class Element {
    value = ''; textContent = ''; style = {}; children = [];
    replaceChildren(...items) { this.children = items; }
    append(...items) { this.children.push(...items); }
    reportValidity() { return true; }
  }
  const controls = new Map();
  const control = name => {
    if (!controls.has(name)) controls.set(name, new Element());
    return controls.get(name);
  };
  const data = new Map();
  const events = [];
  let user = null;
  let rejectScope = false;
  let resolveSignIn;
  let authChanged;
  let snapshotHook = async () => backup;
  let getUserHook;
  let rows = [];
  let importResult = true;
  const mockClient = {
    auth: {
      onAuthStateChange: callback => { authChanged = callback; return {data: {subscription: {unsubscribe() {}}}}; },
      getSession: async () => ({data: {session: user ? {user, access_token: 'test-token'} : null}, error: null}),
      getUser: async () => getUserHook ? getUserHook() : ({data: {user}, error: null}),
      signInWithPassword: async () => {
        if (resolveSignIn) await new Promise(resolveSignIn);
        user = account; events.push('signin'); return {data: {user}, error: null};
      },
      signOut: async () => { user = null; events.push('signout'); return {error: null}; },
    },
    from: () => ({select: () => ({order: async () => ({data: rows, error: null}), eq: () => ({single: async () => ({data: {...rows[0], progress: backup.state}, error: null})})})}),
    rpc: async (_name, args) => { events.push({upload: args}); return {data: {revision: 1}, error: null}; },
  };
  const context = vm.createContext({
    URL, TextEncoder, Uint8Array, crypto, HTMLElement: Element,
    document: {querySelector: control, createElement: () => new Element()},
    localStorage: {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value)},
    fetch: async () => ({json: async () => ({})}), confirm: () => true,
    mockCreateClient: (url, _key, options) => { events.push({connect: url, pinnedToken: !!options.global?.headers?.Authorization}); return mockClient; },
    window: {touchline: {
      setAccountScope: async origin => { if (rejectScope) throw Error('Save failed'); events.push({scope: origin}); },
      invalidateAccountScope: async () => { events.push('invalidate'); },
      snapshot: () => snapshotHook(), download: () => {},
      importCloud: async () => importResult,
    }},
  });
  vm.runInContext(bundled.outputFiles[0].text, context);
  return {control, events, setRows: value => { rows = value; }, setImportResult: value => { importResult = value; },
    snapshot: callback => { snapshotHook = callback; },
    verifyUser: callback => { getUserHook = callback; },
    emitAuth: (event, nextUser) => { user = nextUser; authChanged(event, nextUser ? {user: nextUser} : null); },
    setRejectScope: value => { rejectScope = value; },
    holdSignIn: callback => { resolveSignIn = callback; },
    async idle() { await new Promise(resolve => setTimeout(resolve, 20)); },
    async connect(url = 'https://EXAMPLE.supabase.co/') {
      control('#cloud-url').value = url;
      control('#cloud-key').value = 'sb_publishable_test';
      control('#cloud-connection').onsubmit({preventDefault() {}});
      await this.idle();
    },
    async signin() { control('#cloud-auth').onsubmit({preventDefault() {}}); await this.idle(); },
  };
}

test('connection, sign-in, publication and sign-out keep scope and revisions separate', async () => {
  const h = harness(); await h.idle(); await h.connect();
  assert.equal(h.events.find(event => event.connect)?.connect, 'https://example.supabase.co');
  await h.signin();
  assert.equal(h.events.filter(event => event.scope).at(-1).scope.accountId, account.id);
  await h.control('#cloud-upload').onclick();
  assert.equal(h.events.find(event => event.upload).upload.expected_revision, -1);
  await h.control('#cloud-upload').onclick();
  assert.equal(h.events.filter(event => event.upload).at(-1).upload.expected_revision, 1);
  await h.control('#cloud-signout').onclick();
  assert.equal(h.events.at(-2).scope, null);
  assert.equal(h.events.at(-1), 'signout');
  assert.match(h.control('#cloud-status').textContent, /Signed out/);
});

test('a failed local save prevents account or backend replacement', async () => {
  const h = harness(); await h.idle(); await h.connect(); await h.signin();
  h.setRejectScope(true);
  const previous = h.events.length;
  await h.control('#cloud-signout').onclick();
  await h.connect('https://another.supabase.co');
  assert.equal(h.events.length, previous);
  assert.match(h.control('#cloud-status').textContent, /Save failed/);
});

test('account actions do not overlap', async () => {
  const h = harness(); await h.idle(); await h.connect();
  let release;
  h.holdSignIn(resolve => { release = resolve; });
  await h.signin();
  await h.control('#cloud-signout').onclick();
  assert.match(h.control('#cloud-status').textContent, /Wait for the current account operation/);
  assert.equal(h.events.includes('signout'), false);
  release(); await h.idle();
  assert.equal(h.events.filter(event => event.scope).at(-1).scope.accountId, account.id);
});


test('external sign-out hides cloud records and cancels a delayed publication', async () => {
  const h = harness(); await h.idle(); await h.connect(); await h.signin();
  let finishSnapshot;
  h.snapshot(() => new Promise(resolve => { finishSnapshot = resolve; }));
  const publishing = h.control('#cloud-upload').onclick();
  await h.idle();
  h.emitAuth('SIGNED_OUT', null);
  assert.equal(h.events.at(-1), 'invalidate');
  finishSnapshot(backup); await publishing;
  assert.equal(h.events.some(event => event.upload), false);
  assert.match(h.control('#cloud-status').textContent, /account changed/);
});

test('canceled download keeps the previous remote revision', async () => {
  const h = harness(); await h.idle(); await h.connect();
  h.setRows([{id: backup.curriculum.id, curriculum: backup.curriculum, revision: 20, updated_at: '2026-10-28T00:00:00Z'}]);
  await h.signin();
  h.setImportResult(false);
  const section = h.control('#cloud-courses').children[0];
  await section.children[2].onclick();
  assert.match(h.control('#cloud-status').textContent, /Download canceled/);
  await h.control('#cloud-upload').onclick();
  assert.equal(h.events.find(event => event.upload).upload.expected_revision, -1);
  assert.equal(h.events.filter(event => event.pinnedToken).length > 0, true);
});


test('a new sign-in interrupts initial account verification before scope selection', async () => {
  const h = harness(); await h.idle(); await h.connect();
  let finishVerification;
  h.verifyUser(() => new Promise(resolve => { finishVerification = resolve; }));
  await h.signin();
  h.emitAuth('SIGNED_IN', {id: 'fa057912-c6e0-4d07-87bb-34973675f9ca', email: 'second@example.com'});
  finishVerification({data: {user: account}, error: null}); await h.idle();
  assert.equal(h.events.some(event => event.scope?.accountId), false);
  assert.match(h.control('#cloud-status').textContent, /account changed/);
});
