import {createClient} from '@supabase/supabase-js';
import {canonicalBackendOrigin, legacyAccountScope} from './web/account-scope.js';
import {projectPublication} from './web/publication.js';
/**
 * @template {keyof TouchlineElements} K
 * @overload
 * @param {K} selector
 * @returns {TouchlineElements[K]}
 */
/** @overload @param {string} selector @returns {HTMLElement} */
/** @param {string} selector @returns {HTMLElement} */
function $(selector) {
 const element = document.querySelector(selector);
 if (!(element instanceof HTMLElement)) throw new Error(`Missing control: ${selector}`);
 return element;
}
/** @param {unknown} error */
const message = error => error instanceof Error ? error.message : String(error);
/** @type {import('@supabase/supabase-js').SupabaseClient<TouchlineDatabase> | undefined} */ let client;
/** @type {HubConnection | undefined} */ let connection;
/** @type {Record<string, number>} */ let revisions = {};
/** @type {string | null} */ let revisionKey = null;
let busy = false;
let accountEpoch = 0;
/** @type {string | null} */ let activeAccountId = null;
/** @type {(() => void) | undefined} */ let unsubscribe;
/** @param {number} epoch */
function requireAccountEpoch(epoch) {
 if (epoch !== accountEpoch) throw Error('The account changed. Start this operation again.');
}
function observeAccount() {
 unsubscribe?.();
 const observedClient = backend();
 /** @type {string | null | undefined} */ let observedAccountId;
 const {data: {subscription}} = observedClient.auth.onAuthStateChange((event, session) => {
  if (client !== observedClient) return;
  const nextAccountId = session?.user?.id ?? null;
  const changed = event !== 'INITIAL_SESSION' && nextAccountId !== observedAccountId;
  observedAccountId = nextAccountId;
  if (event === 'SIGNED_OUT' || changed || (activeAccountId && nextAccountId !== activeAccountId)) {
   accountEpoch += 1;
   activeAccountId = null;
   loadRevisions(null);
   $('#cloud-courses').replaceChildren();
   // Do not await Supabase methods inside its auth callback. Hide cached cloud
   // content at once and retain any unfinished work in its device journal.
   void window.touchline.invalidateAccountScope().catch(error => say(message(error), true));
  }
 });
 unsubscribe = () => subscription.unsubscribe();
}
function backend() {
 if (!client) throw new Error('Connect your backend first.');
 return client;
}
/** @param {import('@supabase/supabase-js').User | null | undefined} user */
function loadRevisions(user) {
 revisionKey = user && connection ? 'touchline-revisions:' + connection.url + ':' + user.id : null;
 try {
  const saved = revisionKey ? JSON.parse(localStorage.getItem(revisionKey) || '{}') : {};
  revisions = Object.fromEntries(Object.entries(saved).filter(([, value]) => Number.isSafeInteger(value) && Number(value) >= 0));
 } catch { revisions = {}; }
}
function persistRevisions() {
 if (revisionKey) {
  try { localStorage.setItem(revisionKey, JSON.stringify(revisions)); }
  catch { throw Error('The transfer finished, but this browser could not save its revision. Download the latest copy before publishing again.'); }
 }
}
/** @param {string} text */
const say = (text, error = false) => { $('#cloud-status').textContent = text; $('#cloud-status').style.color = error ? '#922f1e' : ''; };
/** @param {HubConnection} value */
function validateConnection(value) {
 const url = canonicalBackendOrigin(value.url);
 if (!value.publishableKey || value.publishableKey.startsWith('sb_secret_')) throw Error('Use a publishable key, never a secret key.');
 if (value.publishableKey.startsWith('ey')) {
  try {
   const body = JSON.parse(atob(value.publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
   if (body.role !== 'anon') throw Error();
  } catch { throw Error('Only a publishable key or legacy anon key is allowed.'); }
 }
 return {url, publishableKey: value.publishableKey};
}
/** Resolve the account through Supabase before selecting its downloaded records. */
async function verifiedAccount() {
 const epoch = accountEpoch;
 const {data: sessionData, error: sessionError} = await backend().auth.getSession();
 requireAccountEpoch(epoch);
 const token = sessionData.session?.access_token;
 const {data, error} = token ? await backend().auth.getUser(token) : {data: {user: null}, error: sessionError};
 requireAccountEpoch(epoch);
 if (sessionError || error || !data.user || !connection || !token || sessionData.session?.user.id !== data.user.id) {
  await window.touchline.invalidateAccountScope();
  activeAccountId = null;
  loadRevisions(null);
  $('#cloud-courses').replaceChildren();
  throw Error('Sign in to access your published records.');
 }
 const origin = await legacyAccountScope(connection.url, data.user.id);
 requireAccountEpoch(epoch);
 await window.touchline.setAccountScope(origin);
 requireAccountEpoch(epoch);
 activeAccountId = data.user.id;
 loadRevisions(data.user);
 const transfer = createClient(connection.url, connection.publishableKey, {
  // A fixed token avoids creating another shared browser auth session.
  accessToken: async () => token,
  global: {headers: {Authorization: 'Bearer ' + token}},
 });
 return {user: data.user, origin, epoch, transfer};
}
/** @param {HubConnection} value */
async function connect(value) {
 const next = validateConnection(value);
 // Save before switching, including any visible draft that belongs to the old account.
 await window.touchline.setAccountScope(null);
 if (client) {
  const {error} = await backend().auth.signOut({scope: 'local'});
  if (error) throw error;
 }
 unsubscribe?.();
 accountEpoch += 1;
 activeAccountId = null;
 connection = next;
 loadRevisions(null);
 $('#cloud-courses').replaceChildren();
 client = createClient(next.url, next.publishableKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
 observeAccount();
 localStorage.setItem('touchline-backend', JSON.stringify(next));
 $('#cloud-url').value = next.url;
 $('#cloud-key').value = next.publishableKey;
 say('Backend connected. Sign in to access your records.');
}
/** @param {() => Promise<void>} operation */
async function guarded(operation) {
 if (busy) { say('Wait for the current account operation to finish.'); return; }
 busy = true;
 try { await operation(); }
 catch (error) { say(message(error), true); }
 finally { busy = false; }
}
async function list() {
 const {epoch, transfer} = await verifiedAccount();
 const {data, error} = await transfer.from('learning_courses').select('id,curriculum,revision,updated_at').order('updated_at', {ascending: false});
 if (error) throw error;
 requireAccountEpoch(epoch);
 const root = $('#cloud-courses');
 root.replaceChildren();
 if (!data.length) {
  root.textContent = 'No published courses yet. Publish your current course to make it available on iPhone and iPad.';
  return;
 }
 for (const row of data) {
  const section = document.createElement('article');
  section.className = 'journal-entry';
  const title = document.createElement('h3');
  title.textContent = row.curriculum.title;
  const meta = document.createElement('p');
  meta.textContent = 'Published ' + new Date(row.updated_at).toLocaleString();
  const button = document.createElement('button');
  button.textContent = 'Download to this computer';
  button.onclick = () => guarded(async () => {
   const {origin, epoch, transfer} = await verifiedAccount();
   const {data: latest, error} = await transfer.from('learning_courses').select('*').eq('id', row.id).single();
   if (error) throw error;
   requireAccountEpoch(epoch);
   const imported = await window.touchline.importCloud({curriculum: latest.curriculum, state: latest.progress}, origin);
   requireAccountEpoch(epoch);
   if (!imported) { say('Download canceled. Your saved copy is unchanged.'); return; }
   revisions[row.id] = latest.revision;
   persistRevisions();
   say('Downloaded ' + latest.curriculum.title);
  });
  section.append(title, meta, button);
  root.append(section);
 }
}
$('#cloud-connection').onsubmit = event => {
 event.preventDefault();
 void guarded(() => connect({url: $('#cloud-url').value.trim(), publishableKey: $('#cloud-key').value.trim()}));
};
$('#cloud-auth').onsubmit = event => {
 event.preventDefault();
 void guarded(async () => {
  await window.touchline.setAccountScope(null);
  const {error} = await backend().auth.signInWithPassword({email: $('#cloud-email').value.trim(), password: $('#cloud-password').value});
  if (error) throw error;
  $('#cloud-password').value = '';
  await list();
  say('Signed in. Your records are private to this account.');
 });
};
$('#cloud-signup').onclick = () => guarded(async () => {
 if (!$('#cloud-auth').reportValidity()) return;
 await window.touchline.setAccountScope(null);
 const {data, error} = await backend().auth.signUp({email: $('#cloud-email').value.trim(), password: $('#cloud-password').value});
 if (error) throw error;
 $('#cloud-password').value = '';
 if (data.session) await verifiedAccount();
 say(data.session ? 'Owner account ready.' : 'Open the confirmation email, then return here to sign in.');
});
$('#cloud-signout').onclick = () => guarded(async () => {
 await window.touchline.setAccountScope(null);
 const {error} = await backend().auth.signOut();
 if (error) throw error;
 loadRevisions(null);
 $('#cloud-courses').replaceChildren();
 say('Signed out. Local learning records remain on this computer.');
});
$('#cloud-refresh').onclick = () => guarded(list);
$('#cloud-upload').onclick = () => guarded(async () => {
 const {epoch, transfer} = await verifiedAccount();
 const backup = projectPublication(await window.touchline.snapshot());
 requireAccountEpoch(epoch);
 const {data, error} = await transfer.rpc('save_learning_course', {
  course_id: backup.curriculum.id, course_content: backup.curriculum,
  course_progress: backup.state, expected_revision: Object.hasOwn(revisions, backup.curriculum.id) ? revisions[backup.curriculum.id] : -1,
 });
 if (error) throw error;
 requireAccountEpoch(epoch);
 revisions[backup.curriculum.id] = data.revision;
 persistRevisions();
 say('Published. Refresh the native app to read this copy.');
 await list();
});
$('#export-connection').onclick = () => {
 try {
  const value = validateConnection({url: $('#cloud-url').value.trim(), publishableKey: $('#cloud-key').value.trim()});
  window.touchline.download({format: 'touchline-connection', ...value}, 'touchline-connection.json');
 } catch (error) { say(message(error), true); }
};
void guarded(async () => {
 const saved = localStorage.getItem('touchline-backend');
 const value = saved ? JSON.parse(saved) : await (await fetch('/api/cloud-config')).json();
 if (!value.url) return;
 connection = validateConnection(value);
 client = createClient(connection.url, connection.publishableKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
 observeAccount();
 const epoch = accountEpoch;
 $('#cloud-url').value = connection.url;
 $('#cloud-key').value = connection.publishableKey;
 const {data, error} = await backend().auth.getUser();
 requireAccountEpoch(epoch);
 if (error || !data.user) { say('Backend ready. Sign in to access your records.'); return; }
 const origin = await legacyAccountScope(connection.url, data.user.id);
 requireAccountEpoch(epoch);
 await window.touchline.setAccountScope(origin);
 requireAccountEpoch(epoch);
 activeAccountId = data.user.id;
 loadRevisions(data.user);
 say('Signed in as ' + data.user.email);
});
