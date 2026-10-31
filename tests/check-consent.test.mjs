import assert from 'node:assert/strict';
import test from 'node:test';
import {createCheckService, CheckServiceError, TOKEN_HEADER} from '../web/services/checks.js';
import {openCheckConsent} from '../web/screens/check-consent.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
const HASH = 'ab'.repeat(32);
const ref = {moduleId: 'intro', version: '1.0.0', checkId: 'script-a'};
const inspection = {
  needsConsent: true, checkHash: HASH, runnerType: 'script', description: 'Runs the tests.', runtime: 'python3',
  source: 'print("hello")\nprint(1 < 2)\n', args: ['--fast'], timeoutSeconds: 30, workspace: '/work/project',
};

/** A fake server. `handlers` answers by "METHOD path". Every call is recorded with its headers and body. */
function server(handlers) {
  const calls = [];
  const transport = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    calls.push({key, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined, credentials: options.credentials});
    const answer = handlers[key];
    if (!answer) throw new Error(`unexpected call ${key}`);
    return typeof answer === 'function' ? answer(calls.filter(call => call.key === key).length) : answer;
  };
  return {calls, service: createCheckService(transport)};
}
const session = {'GET /api/checks/session': () => json({token: 'token-one'})};

/** A tiny stand-in for the document. Server words must arrive as text, so innerHTML throws. */
function installDom() {
  const doc = {activeElement: null};
  const make = tag => {
    const element = {
      tag, children: [], attributes: {}, listeners: {}, _text: '', className: '', ownerDocument: doc,
      set textContent(value) { this._text = String(value); this.children = []; },
      get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
      set innerHTML(value) { throw new Error('innerHTML is not allowed: ' + value); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      append(...nodes) { for (const node of nodes) this.children.push(typeof node === 'string' ? Object.assign(make('#text'), {_text: node}) : node); },
      replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); },
      addEventListener(name, handler) { this.listeners[name] = handler; },
    };
    return element;
  };
  doc.createElement = make;
  globalThis.document = doc;
  globalThis.HTMLElement = class {};
  return Object.assign(make('dialog'), {open: false, showModal() { this.open = true; }, close() { this.open = false; }});
}
const walk = (node, visit) => { visit(node); node.children.forEach(child => walk(child, visit)); };
const find = (dialog, test) => { const found = []; walk(dialog, node => { if (test(node)) found.push(node); }); return found; };
const buttons = dialog => find(dialog, node => node.tag === 'button');
const labelled = (dialog, label) => buttons(dialog).find(button => button.textContent === label);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const click = async (dialog, label) => {
  const button = labelled(dialog, label);
  assert.ok(button, `a button named "${label}" in: ${dialog.textContent}`);
  button.listeners.click();
  await settle();
};

test('the service fetches the token once and sends it on every other call', async () => {
  const {calls, service} = server({
    ...session,
    'GET /api/checks/workspace': json({path: null, configured: false, usable: false}),
    'POST /api/checks/inspect': json(inspection),
  });
  await service.getWorkspace();
  await service.inspect(ref);
  assert.deepEqual(calls.map(call => call.key), ['GET /api/checks/session', 'GET /api/checks/workspace', 'POST /api/checks/inspect']);
  assert.equal(calls[0].headers[TOKEN_HEADER], undefined);
  assert.equal(calls[1].headers[TOKEN_HEADER], 'token-one');
  assert.equal(calls[2].headers[TOKEN_HEADER], 'token-one');
  assert.equal(calls[2].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[2].body, ref);
  assert.ok(calls.every(call => call.credentials === 'omit'));
});

test('a rejected token is fetched again once, and the call is retried once', async () => {
  let tokens = 0;
  const {calls, service} = server({
    'GET /api/checks/session': () => json({token: `token-${++tokens}`}),
    'POST /api/checks/inspect': count => count === 1 ? json({error: 'No.', code: 'invalid_token'}, 403) : json(inspection),
  });
  const shown = await service.inspect(ref);
  assert.equal(shown.checkHash, HASH);
  assert.deepEqual(calls.map(call => call.key), ['GET /api/checks/session', 'POST /api/checks/inspect', 'GET /api/checks/session', 'POST /api/checks/inspect']);
  assert.equal(calls[3].headers[TOKEN_HEADER], 'token-2');
});

test('a token that keeps failing is not retried forever', async () => {
  const {calls, service} = server({
    ...session,
    'POST /api/checks/inspect': () => json({error: 'No.', code: 'invalid_token'}, 403),
  });
  await assert.rejects(() => service.inspect(ref), error => error instanceof CheckServiceError && error.code === 'invalid_token');
  assert.equal(calls.filter(call => call.key === 'POST /api/checks/inspect').length, 2);
});

test('consent sends the hash that was shown and confirm true, and nothing else', async () => {
  const {calls, service} = server({...session, 'POST /api/checks/consent': json({consentId: 'c'.repeat(24), checkHash: HASH, workspace: '/work/project'})});
  const granted = await service.grantConsent(ref, {confirm: true, shownHash: HASH});
  assert.equal(granted.consentId, 'c'.repeat(24));
  assert.deepEqual(calls[1].body, {...ref, confirm: true, shownHash: HASH});
});

test('consent refuses to leave the page without confirm true', async () => {
  for (const options of [undefined, {}, {confirm: false, shownHash: HASH}, {confirm: 'true', shownHash: HASH}, {confirm: true}, {confirm: true, shownHash: 'short'}]) {
    const {calls, service} = server({...session});
    await assert.rejects(() => service.grantConsent(ref, options), error => error instanceof CheckServiceError && error.code === 'confirmation_required');
    assert.equal(calls.length, 0);
  }
});

test('a run request carries no consent field except an optional consent id', async () => {
  const {calls, service} = server({...session, 'POST /api/checks/run': () => json({tier: 2, result: {status: 'passed', evidence: {}, log: []}})});
  await service.run(ref);
  await service.run(ref, 'c'.repeat(24));
  assert.deepEqual(calls[1].body, ref);
  assert.deepEqual(calls[2].body, {...ref, consentId: 'c'.repeat(24)});
  for (const call of calls.slice(1)) assert.ok(!('confirm' in call.body) && !('shownHash' in call.body));
});

test('server errors map to plain text and the server words stay in detail', async () => {
  const cases = {
    consent_required: 403, busy: 429, workspace_required: 409, invalid_workspace: 400, hash_mismatch: 409, not_found: 404, payload_too_large: 413,
    forbidden_origin: 403, internal_error: 500, corrupt_file: 500, consent_not_needed: 400,
  };
  for (const [code, status] of Object.entries(cases)) {
    const {service} = server({...session, 'POST /api/checks/run': json({error: 'Secret /Users/x detail‮', code}, status)});
    await assert.rejects(() => service.run(ref), error => {
      assert.ok(error instanceof CheckServiceError, code);
      assert.equal(error.serverCode, code);
      assert.equal(error.status, status);
      assert.ok(error.message.length > 10 && !error.message.includes('/Users'), error.message);
      assert.ok(!/[‮]/.test(error.detail));
      assert.ok(!/[;—]/.test(error.message) && !/\b\w+n't\b/.test(error.message), error.message);
      return true;
    }, code);
  }
});

test('a network failure and a bad answer are reported without a crash', async () => {
  const down = createCheckService(async () => { throw new Error('offline'); });
  await assert.rejects(() => down.getWorkspace(), error => error.code === 'network_error');
  const {service} = server({...session, 'GET /api/checks/workspace': new Response('not json', {status: 200})});
  await assert.rejects(() => service.getWorkspace(), error => error.code === 'invalid_response');
});

test('a request that is too large is refused before it leaves', async () => {
  const {calls, service} = server({...session});
  await assert.rejects(() => service.setWorkspace('/a'.repeat(40000)), error => error.code === 'too_large');
  assert.equal(calls.filter(call => call.key.startsWith('POST')).length, 0);
});

test('the consent dialog shows the runtime, the source, the hash, the folder, and says it is not a sandbox', async () => {
  const dialog = installDom();
  const {service} = server({...session, 'POST /api/checks/inspect': json(inspection)});
  openCheckConsent(dialog, {service, ref});
  await settle();
  const text = dialog.textContent;
  assert.ok(dialog.open);
  assert.match(text, /python3/);
  assert.ok(text.includes('print("hello")\nprint(1 < 2)\n'));
  assert.ok(text.includes(HASH));
  assert.ok(text.includes('/work/project'));
  assert.ok(text.includes('--fast'));
  assert.match(text, /30 seconds/);
  assert.match(text, /consent, not a sandbox/i);
  assert.match(text, /read your files and use the network/);
  assert.ok(labelled(dialog, 'Agree and allow this script'));
  assert.ok(labelled(dialog, 'Cancel'));
  assert.ok(!/[;—]/.test(text.replace(inspection.source, '')), 'plain punctuation in the fixed text');
});

test('Cancel and Escape make no call after the review is shown', async () => {
  for (const how of ['cancel', 'escape']) {
    const dialog = installDom();
    const {calls, service} = server({...session, 'POST /api/checks/inspect': json(inspection)});
    const finished = [];
    openCheckConsent(dialog, {service, ref, onFinish: result => finished.push(result)});
    await settle();
    const before = calls.map(call => call.key);
    if (how === 'cancel') await click(dialog, 'Cancel');
    else dialog.oncancel({preventDefault() {}});
    await settle();
    assert.equal(dialog.open, false, how);
    assert.deepEqual(calls.map(call => call.key), before, how);
    assert.ok(!calls.some(call => call.key.includes('consent') || call.key.includes('run')), how);
    assert.deepEqual(finished, [{consented: false}], how);
  }
});

test('Agree sends one consent call with the shown hash, then closes by the student', async () => {
  const dialog = installDom();
  const {calls, service} = server({
    ...session,
    'POST /api/checks/inspect': json(inspection),
    'POST /api/checks/consent': json({consentId: 'c'.repeat(24), checkHash: HASH, workspace: '/work/project'}),
  });
  const finished = [];
  openCheckConsent(dialog, {service, ref, onFinish: result => finished.push(result)});
  await settle();
  await click(dialog, 'Agree and allow this script');
  const consentCalls = calls.filter(call => call.key === 'POST /api/checks/consent');
  assert.equal(consentCalls.length, 1);
  assert.deepEqual(consentCalls[0].body, {...ref, confirm: true, shownHash: HASH});
  assert.ok(!calls.some(call => call.key.includes('/run')), 'consent does not run the script');
  assert.match(dialog.textContent, /has not run yet/);
  await click(dialog, 'Close');
  assert.equal(dialog.open, false);
  assert.deepEqual(finished, [{consented: true, consentId: 'c'.repeat(24)}]);
});

test('a second click on Agree while the call is pending makes no second call', async () => {
  const dialog = installDom();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {calls, service} = server({
    ...session,
    'POST /api/checks/inspect': json(inspection),
    'POST /api/checks/consent': async () => { await gate; return json({consentId: 'c'.repeat(24), checkHash: HASH, workspace: '/w'}); },
  });
  openCheckConsent(dialog, {service, ref});
  await settle();
  const agree = labelled(dialog, 'Agree and allow this script');
  agree.listeners.click();
  agree.listeners.click();
  await settle();
  release();
  await settle();
  assert.equal(calls.filter(call => call.key === 'POST /api/checks/consent').length, 1);
});

test('a changed script is shown again and consent is not given', async () => {
  const dialog = installDom();
  const changed = {...inspection, source: 'print("different")\n', checkHash: 'cd'.repeat(32)};
  const {calls, service} = server({
    ...session,
    'POST /api/checks/inspect': count => json(count === 1 ? inspection : changed),
    'POST /api/checks/consent': json({error: 'The script changed.', code: 'hash_mismatch'}, 409),
  });
  openCheckConsent(dialog, {service, ref});
  await settle();
  await click(dialog, 'Agree and allow this script');
  assert.match(dialog.textContent, /changed since it was shown/);
  assert.ok(dialog.textContent.includes('print("different")'));
  assert.ok(dialog.textContent.includes('cd'.repeat(32)));
  assert.equal(calls.filter(call => call.key === 'POST /api/checks/consent').length, 1);
  assert.ok(labelled(dialog, 'Agree and allow this script'));
});

test('a check that runs no script says so and offers no consent', async () => {
  const dialog = installDom();
  const {calls, service} = server({...session, 'POST /api/checks/inspect': json({...inspection, needsConsent: false, source: null, runtime: null})});
  openCheckConsent(dialog, {service, ref});
  await settle();
  assert.match(dialog.textContent, /runs no script/);
  assert.equal(labelled(dialog, 'Agree and allow this script'), undefined);
  await click(dialog, 'Close');
  assert.ok(!calls.some(call => call.key.includes('consent')));
});

test('server text is shown as text only, and hidden direction marks in a script are made visible', async () => {
  const dialog = installDom();
  const evil = {...inspection, workspace: '/work/<img src=x onerror=alert(1)>', source: 'x = "a‮b"  # <script>alert(1)</script>\n​print(1)', args: ['<b>x</b>'], runtime: 'python3'};
  const {service} = server({...session, 'POST /api/checks/inspect': json(evil)});
  openCheckConsent(dialog, {service, ref});
  await settle();
  const text = dialog.textContent;
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(text.includes('<script>alert(1)</script>'));
  assert.ok(!text.includes('‮') && !text.includes('​'));
  assert.match(text, /U\+202E/);
  assert.match(text, /U\+200B/);
});

test('a failed inspect shows a message and offers only Close', async () => {
  const dialog = installDom();
  const {calls, service} = server({...session, 'POST /api/checks/inspect': json({error: 'x', code: 'workspace_required'}, 409)});
  openCheckConsent(dialog, {service, ref});
  await settle();
  assert.match(dialog.textContent, /folder where you do your work/);
  assert.equal(labelled(dialog, 'Agree and allow this script'), undefined);
  await click(dialog, 'Close');
  assert.equal(dialog.open, false);
  assert.ok(!calls.some(call => call.key.includes('consent')));
});
