import assert from 'node:assert/strict';
import test from 'node:test';
import {createLessonService} from '../web/services/lessons.js';
import {openModuleImport} from '../web/screens/module-import-dialog.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status});

/** A tiny stand-in for the document. Server words must arrive as text, so innerHTML throws. */
function installDom() {
  const doc = {activeElement: null};
  const make = tag => {
    const element = {
      tag, children: [], attributes: {}, listeners: {}, _text: '', ownerDocument: doc,
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
  const dialog = Object.assign(make('dialog'), {open: false, showModal() { this.open = true; }, close() { this.open = false; }});
  return dialog;
}
const walk = (node, visit) => { visit(node); node.children.forEach(child => walk(child, visit)); };
const buttons = dialog => { const found = []; walk(dialog, node => { if (node.tag === 'button') found.push(node); }); return found; };
const labelled = (dialog, label) => buttons(dialog).find(button => button.textContent === label);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const click = async (dialog, label) => {
  const button = labelled(dialog, label);
  assert.ok(button, `a button named "${label}" in: ${dialog.textContent}`);
  button.listeners.click();
  await settle();
};

const module1 = {kind: 'module', id: 'intro', version: '1.1.0', title: 'Intro', status: 'new', state: 'new', taskCount: 1, checkCount: 1, prerequisites: [], missingPrerequisites: [],
  pin: 'newer-than-pin', pinnedVersion: '1.0.0', newerVersionAvailable: '1.1.0'};
const preview = {importable: true, kind: 'module', files: [module1], modules: [module1], conflicts: [], problems: []};
const entry = {id: 'intro', title: 'Intro', versions: ['1.0.0', '1.1.0'], pinnedVersion: '1.0.0', newerVersionAvailable: '1.1.0'};

/** A fake server. `handlers` answers by "METHOD path". Every call is recorded. */
function server(handlers) {
  const calls = [];
  const transport = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    calls.push({key, body: options.body ? JSON.parse(options.body) : undefined});
    const answer = handlers[key];
    if (!answer) throw new Error(`unexpected call ${key}`);
    return typeof answer === 'function' ? answer(calls.filter(call => call.key === key).length) : answer;
  };
  return {calls, service: createLessonService(transport)};
}

test('Cancel and Escape during the review close the dialog and make no import call', async () => {
  for (const how of ['cancel', 'escape']) {
    const dialog = installDom();
    const {calls, service} = server({'POST /api/lessons/import/preview': json(preview)});
    openModuleImport(dialog, {service, source: '{}', filename: 'a.json'});
    await settle();
    assert.equal(dialog.open, true);
    assert.ok(labelled(dialog, 'Add these lessons'));
    if (how === 'cancel') await click(dialog, 'Cancel');
    else dialog.oncancel({preventDefault() {}});
    await settle();
    assert.equal(dialog.open, false, how);
    assert.deepEqual(calls.map(call => call.key), ['POST /api/lessons/import/preview'], how);
  }
});

test('lessons that were added but cannot be listed say so, and the dialog does not claim a clean finish', async () => {
  const dialog = installDom();
  const {service} = server({
    'POST /api/lessons/import/preview': json(preview),
    'POST /api/lessons/import': json({imported: [{kind: 'module', id: 'intro', version: '1.1.0', status: 'new'}], revision: 2}),
    'GET /api/lessons': json({error: 'Secret detail.', code: 'internal_error'}, 500),
  });
  openModuleImport(dialog, {service, source: '{}', filename: 'a.json'});
  await settle();
  await click(dialog, 'Add these lessons');
  const text = dialog.textContent;
  assert.match(text, /The lessons were added, but Schola could not read the lesson list\./);
  assert.match(text, /unexpected problem/);
  assert.ok(!/Review the switch/.test(text));
  const alerts = []; walk(dialog, node => { if (node.attributes.role === 'alert') alerts.push(node); });
  assert.equal(alerts.length, 1, 'the problem is announced as an alert');
});

test('a failed pin switch reads the lessons again and the next try uses the new revision', async () => {
  const dialog = installDom();
  const {calls, service} = server({
    'POST /api/lessons/import/preview': json(preview),
    'POST /api/lessons/import': json({imported: [], revision: 3, modules: [entry]}),
    'POST /api/lessons/pins': count => count === 1 ? json({error: 'Newer changes were saved.', code: 'revision_conflict'}, 409) : json({revision: 8, modules: [{...entry, pinnedVersion: '1.1.0', newerVersionAvailable: null}]}),
    'GET /api/lessons': json({revision: 7, modules: [entry]}),
  });
  openModuleImport(dialog, {service, source: '{}', filename: 'a.json'});
  await settle();
  await click(dialog, 'Add these lessons');
  await click(dialog, 'Review the switch');
  assert.equal(calls.filter(call => call.key === 'POST /api/lessons/pins').length, 0, 'the review step moves nothing');
  await click(dialog, 'Switch to version 1.1.0');
  assert.match(dialog.textContent, /Your lessons changed since you opened this screen/);
  assert.deepEqual(calls.filter(call => call.key === 'POST /api/lessons/pins').map(call => call.body.expectedRevision), [3]);
  assert.equal(calls.filter(call => call.key === 'GET /api/lessons').length, 1, 'the lessons were read again');
  await click(dialog, 'Review the switch');
  await click(dialog, 'Switch to version 1.1.0');
  assert.deepEqual(calls.filter(call => call.key === 'POST /api/lessons/pins').map(call => call.body.expectedRevision), [3, 7]);
  assert.match(dialog.textContent, /You now use version 1\.1\.0/);
});

test('a failed pin switch followed by a failed reload shows an error and does not offer another switch', async () => {
  const dialog = installDom();
  const {service} = server({
    'POST /api/lessons/import/preview': json(preview),
    'POST /api/lessons/import': json({imported: [], revision: 3, modules: [entry]}),
    'POST /api/lessons/pins': json({error: 'Newer changes were saved.', code: 'revision_conflict'}, 409),
    'GET /api/lessons': () => { throw new TypeError('Failed to fetch'); },
  });
  openModuleImport(dialog, {service, source: '{}', filename: 'a.json'});
  await settle();
  await click(dialog, 'Add these lessons');
  await click(dialog, 'Review the switch');
  await click(dialog, 'Switch to version 1.1.0');
  const text = dialog.textContent;
  assert.match(text, /The switch failed, and Schola could not reload your lessons/);
  assert.match(text, /Your lessons changed since you opened this screen/, 'the first failure stays visible');
  assert.match(text, /did not answer/, 'the reload failure stays visible');
  const alerts = []; walk(dialog, node => { if (node.attributes.role === 'alert') alerts.push(node); });
  assert.ok(alerts.length >= 1);
  assert.equal(labelled(dialog, 'Switch to version 1.1.0'), undefined);
});

test('declining a switch makes no call, and Close ends the dialog', async () => {
  const dialog = installDom();
  const finished = [];
  const {calls, service} = server({
    'POST /api/lessons/import/preview': json(preview),
    'POST /api/lessons/import': json({imported: [{kind: 'module', id: 'intro', version: '1.1.0', status: 'new'}], revision: 3, modules: [entry]}),
  });
  openModuleImport(dialog, {service, source: '{}', filename: 'a.json', onFinish: imported => finished.push(imported)});
  await settle();
  await click(dialog, 'Add these lessons');
  await click(dialog, 'Review the switch');
  await click(dialog, 'Keep version 1.0.0');
  assert.ok(labelled(dialog, 'Review the switch'), 'the offer is back');
  await click(dialog, 'Close');
  assert.equal(dialog.open, false);
  assert.deepEqual(finished, [true]);
  assert.deepEqual(calls.map(call => call.key), ['POST /api/lessons/import/preview', 'POST /api/lessons/import']);
});

test('a preview that fails shows the error and Close ends the dialog with nothing imported', async () => {
  const dialog = installDom();
  const finished = [];
  const {calls, service} = server({'POST /api/lessons/import/preview': json({error: 'x', code: 'payload_too_large'}, 413)});
  openModuleImport(dialog, {service, source: '{}', filename: 'a.json', onFinish: imported => finished.push(imported)});
  await settle();
  assert.match(dialog.textContent, /too large/i);
  await click(dialog, 'Close');
  assert.equal(dialog.open, false);
  assert.deepEqual(finished, [false]);
  assert.equal(calls.length, 1);
});
