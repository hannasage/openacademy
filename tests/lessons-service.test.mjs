import assert from 'node:assert/strict';
import test from 'node:test';
import {createLessonService, LessonServiceError} from '../web/services/lessons.js';
import {
  buildImportReview, updateOffers, createImportReviewController, createPinSwitchController, renderImportReview,
} from '../web/screens/module-import.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
/** A fake transport that records every call and answers by path. @param {(url:string,options:any)=>Response|Promise<Response>} answer */
function recorder(answer) {
  const calls = [];
  const transport = async (url, options = {}) => { calls.push({url, options}); return answer(url, options); };
  return {calls, transport};
}
const module1 = {id: 'intro', version: '1.0.0', title: 'Intro', state: 'new', taskCount: 3, checkCount: 2, harness: true, license: {id: 'CC-BY-4.0'}, price: {amount: 1999, currency: 'USD'}, prerequisites: ['basics']};
const preview = {kind: 'module', modules: [module1], conflicts: []};
const source = {schemaVersion: '1.0', id: 'intro', version: '1.0.0'};

test('preview makes only the preview call and sends no credentials', async () => {
  const {calls, transport} = recorder(() => json(preview));
  const service = createLessonService(transport);
  const result = await service.previewImport(source, 'intro.json');
  assert.deepEqual(result, preview);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/lessons/import/preview');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0].options.headers), ['Content-Type']);
  assert.deepEqual(JSON.parse(calls[0].options.body), {source, filename: 'intro.json'});
});

test('every service call stays on the local lesson routes', async () => {
  const {calls, transport} = recorder(() => json({revision: 1, modules: []}));
  const service = createLessonService(transport);
  await service.previewImport(source); await service.importLessons(source); await service.listLessons();
  await service.switchPin('intro', '1.1.0', {confirm: true}); await service.exportLessons();
  await service.previewRestore({format: 'schola-lesson-backup'}); await service.restoreBackup({format: 'schola-lesson-backup'});
  assert.deepEqual(calls.map(call => call.url), [
    '/api/lessons/import/preview', '/api/lessons/import', '/api/lessons', '/api/lessons/pins',
    '/api/lessons/export', '/api/lessons/import/preview', '/api/lessons/import',
  ]);
  for (const call of calls) {
    assert.match(call.url, /^\/api\/lessons(\/|$)/);
    assert.equal(call.options.credentials, 'omit');
    assert.ok(!('Authorization' in (call.options.headers || {})));
    assert.ok(!/^[a-z]+:|\/\//i.test(call.url));
  }
});

test('a pin switch without an explicit confirm makes no call', async () => {
  const {calls, transport} = recorder(() => json({}));
  const service = createLessonService(transport);
  for (const confirm of [false, undefined, 'true', 1]) {
    await assert.rejects(service.switchPin('intro', '1.1.0', {confirm}), error => error instanceof LessonServiceError && error.code === 'confirmation_required');
  }
  await assert.rejects(service.switchPin('intro', '1.1.0'), LessonServiceError);
  assert.equal(calls.length, 0);
  await service.switchPin('intro', '1.1.0', {confirm: true, expectedRevision: 4});
  assert.deepEqual(JSON.parse(calls[0].options.body), {moduleId: 'intro', version: '1.1.0', confirm: true, expectedRevision: 4});
});

test('server errors and network failures surface visible messages', async () => {
  const cases = [
    [409, 'conflict', /different content|already/i],
    [413, 'too_large', /too large/i],
    [422, 'invalid', /not a valid/i],
  ];
  for (const [status, code, pattern] of cases) {
    const service = createLessonService(async () => json({error: 'Server detail.'}, status));
    await assert.rejects(service.importLessons(source), error => error instanceof LessonServiceError && error.status === status && error.code === code && pattern.test(error.message) && error.detail === 'Server detail.');
  }
  await assert.rejects(createLessonService(async () => new Response('<html>too big</html>', {status: 413})).importLessons(source), error => error.code === 'too_large' && error.detail === '');
  await assert.rejects(createLessonService(async () => { throw new TypeError('Failed to fetch'); }).listLessons(), error => error.code === 'network_error' && /did not answer/.test(error.message));
  await assert.rejects(createLessonService(async () => new Response('<html>ok</html>')).listLessons(), error => error.code === 'invalid_response');
});

test('server text is cleaned and capped before it becomes a detail', async () => {
  const noisy = '\u0000\u202Eevil\n' + 'x'.repeat(1000);
  const service = createLessonService(async () => json({error: noisy}, 422));
  await assert.rejects(service.previewImport(source), error => error.detail.length <= 300 && !/[\p{Cc}\p{Cf}]/u.test(error.detail));
});

test('the review lists what an import would add, read only', () => {
  const model = buildImportReview({kind: 'packet', packetTitle: 'Starter', modules: [module1, {id: 'next', version: '2.0.0', title: 'Next', state: 'present'}], knownModuleIds: []}, {filename: 'pack.json'});
  assert.equal(model.items.length, 2);
  const [first, second] = model.items;
  assert.equal(first.title, 'Intro');
  assert.equal(first.version, '1.0.0');
  assert.equal(first.tasks, 3); assert.equal(first.checks, 2);
  assert.match(first.license, /CC-BY-4\.0/);
  assert.match(first.price, /19\.99/);
  assert.match(first.harness, /includes a tutor harness/i);
  assert.ok(first.warnings.some(text => /basics/.test(text)), 'a missing prerequisite is a warning');
  assert.match(second.stateText, /already/i);
  assert.equal(model.canConfirm, true);
  assert.equal(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A', state: 'present'}]}).canConfirm, false);
  assert.match(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A'}]}).items[0].price, /no price/i);
  assert.equal(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A', price: {amount: 0, currency: 'USD'}}]}).items[0].price, 'Free');
  assert.match(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A'}]}).items[0].harness, /no tutor harness/i);
});

test('a prerequisite already in the library or the same import is not a warning', () => {
  const model = buildImportReview({modules: [module1, {id: 'basics', version: '1.0.0', title: 'Basics'}], knownModuleIds: []});
  assert.deepEqual(model.items[0].warnings, []);
  const known = buildImportReview({modules: [module1], knownModuleIds: ['basics']});
  assert.deepEqual(known.items[0].warnings, []);
  const server = buildImportReview({modules: [{...module1, missingPrerequisites: ['other']}]});
  assert.ok(server.items[0].warnings.some(text => /other/.test(text)));
});

test('a same-id different-bytes conflict is flagged and blocks the confirm step', () => {
  const model = buildImportReview({modules: [{...module1, state: 'conflict'}], conflicts: [{id: 'intro', version: '1.0.0'}]});
  assert.equal(model.canConfirm, false);
  assert.equal(model.items[0].state, 'conflict');
  assert.match(model.conflicts[0], /intro/);
  assert.match(model.conflicts[0], /will not replace/i);
  assert.equal(buildImportReview({modules: [module1], conflicts: [{id: 'intro', version: '1.0.0'}]}).canConfirm, false);
});

test('Cancel makes zero calls, before and after the preview', async () => {
  const early = recorder(() => json(preview));
  const first = createImportReviewController({service: createLessonService(early.transport), source, filename: 'a.json'});
  first.cancel();
  assert.equal(first.getState().phase, 'cancelled');
  assert.equal(early.calls.length, 0);
  await first.confirm();
  assert.equal(early.calls.length, 0);

  const late = recorder(() => json(preview));
  const second = createImportReviewController({service: createLessonService(late.transport), source, filename: 'a.json'});
  await second.start();
  assert.equal(late.calls.length, 1);
  second.cancel();
  await second.confirm();
  assert.equal(late.calls.length, 1, 'Cancel adds no call and confirm after Cancel does nothing');
  assert.equal(second.getState().phase, 'cancelled');
  assert.deepEqual(late.calls.map(call => call.url), ['/api/lessons/import/preview']);
});

test('a preview that returns after Cancel is ignored', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {calls, transport} = recorder(async () => { await gate; return json(preview); });
  const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
  const pending = controller.start();
  controller.cancel();
  release(); await pending;
  assert.equal(controller.getState().phase, 'cancelled');
  assert.equal(calls.length, 1);
});

test('import happens only after an explicit confirm', async () => {
  const {calls, transport} = recorder(url => json(url.endsWith('/preview') ? preview : {imported: [{id: 'intro', version: '1.0.0'}], revision: 2}));
  const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
  assert.equal(controller.getState().phase, 'idle');
  await controller.start();
  assert.equal(controller.getState().phase, 'reviewing');
  assert.deepEqual(calls.map(call => call.url), ['/api/lessons/import/preview']);
  await Promise.all([controller.confirm(), controller.confirm()]);
  assert.deepEqual(calls.map(call => call.url), ['/api/lessons/import/preview', '/api/lessons/import']);
  const state = controller.getState();
  assert.equal(state.phase, 'done');
  assert.equal(state.message.kind, 'success');
  assert.match(state.message.text, /1 lesson/);
});

test('confirm before the preview, or over a conflict, makes no import call', async () => {
  const early = recorder(() => json(preview));
  const idle = createImportReviewController({service: createLessonService(early.transport), source, filename: 'a.json'});
  assert.equal(await idle.confirm(), false);
  assert.equal(early.calls.length, 0);

  const conflict = recorder(() => json({modules: [{...module1, state: 'conflict'}], conflicts: [{id: 'intro', version: '1.0.0'}]}));
  const blocked = createImportReviewController({service: createLessonService(conflict.transport), source, filename: 'a.json'});
  await blocked.start();
  assert.equal(await blocked.confirm(), false);
  assert.deepEqual(conflict.calls.map(call => call.url), ['/api/lessons/import/preview']);
  assert.equal(blocked.getState().phase, 'reviewing');
});

test('a failed import never claims success and shows the server problem', async () => {
  for (const [status, pattern] of [[409, /different content|already/i], [413, /too large/i], [422, /not a valid/i]]) {
    const {transport} = recorder(url => url.endsWith('/preview') ? json(preview) : json({error: 'Nope.'}, status));
    const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
    await controller.start(); await controller.confirm();
    const state = controller.getState();
    assert.equal(state.phase, 'failed');
    assert.equal(state.message.kind, 'error');
    assert.match(state.message.text, pattern);
    assert.notEqual(state.message.kind, 'success');
  }
  const down = recorder(url => { if (url.endsWith('/preview')) return json(preview); throw new TypeError('Failed to fetch'); });
  const controller = createImportReviewController({service: createLessonService(down.transport), source, filename: 'a.json'});
  await controller.start(); await controller.confirm();
  assert.equal(controller.getState().phase, 'failed');
  assert.match(controller.getState().message.text, /did not answer/);
});

test('a failed preview shows the problem and offers no confirm step', async () => {
  const {transport} = recorder(() => json({error: 'Bad file.'}, 422));
  const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
  await controller.start();
  assert.equal(controller.getState().phase, 'failed');
  assert.equal(controller.getState().model, null);
  assert.equal(await controller.confirm(), false);
});

test('newer versions appear as offers, and reading the listing never switches a pin', async () => {
  const listing = {revision: 3, modules: [
    {id: 'intro', title: 'Intro', versions: ['1.0.0', '1.1.0'], pinnedVersion: '1.0.0', newerVersionAvailable: '1.1.0'},
    {id: 'other', title: 'Other', versions: ['1.0.0'], pinnedVersion: '1.0.0', newerVersionAvailable: null},
  ]};
  const {calls, transport} = recorder(() => json(listing));
  const result = await createLessonService(transport).listLessons();
  const offers = updateOffers(result);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].moduleId, 'intro');
  assert.equal(offers[0].toVersion, '1.1.0');
  assert.match(offers[0].text, /nothing changes unless you choose/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(updateOffers(null), []);
  assert.deepEqual(updateOffers({modules: [{id: 'a', title: 'A', versions: ['1.0.0'], pinnedVersion: '1.0.0', newerVersionAvailable: '1.0.0'}]}), []);
});

test('a pin switch needs two explicit steps and Cancel makes zero calls', async () => {
  const offer = updateOffers({revision: 3, modules: [{id: 'intro', title: 'Intro', versions: ['1.0.0', '1.1.0'], pinnedVersion: '1.0.0', newerVersionAvailable: '1.1.0'}]})[0];
  const {calls, transport} = recorder(() => json({revision: 4, modules: []}));
  const controller = createPinSwitchController({service: createLessonService(transport), offer, expectedRevision: 3});
  assert.equal(controller.getState().phase, 'offered');
  assert.equal(await controller.confirm(), false, 'confirm before the review step does nothing');
  controller.review();
  assert.equal(controller.getState().phase, 'confirming');
  assert.equal(calls.length, 0);
  controller.cancel();
  assert.equal(controller.getState().phase, 'declined');
  assert.equal(await controller.confirm(), false);
  assert.equal(calls.length, 0);

  const again = createPinSwitchController({service: createLessonService(transport), offer, expectedRevision: 3});
  again.review();
  await Promise.all([again.confirm(), again.confirm()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/lessons/pins');
  assert.deepEqual(JSON.parse(calls[0].options.body), {moduleId: 'intro', version: '1.1.0', confirm: true, expectedRevision: 3});
  assert.equal(again.getState().phase, 'done');
});

test('a failed pin switch never claims success', async () => {
  const offer = {moduleId: 'intro', title: 'Intro', fromVersion: '1.0.0', toVersion: '1.1.0', text: ''};
  const controller = createPinSwitchController({service: createLessonService(async () => json({error: 'Revision moved.'}, 409)), offer});
  controller.review(); await controller.confirm();
  assert.equal(controller.getState().phase, 'failed');
  assert.equal(controller.getState().message.kind, 'error');
});

/** A tiny stand-in for the document, to prove the screen writes text and never markup. */
function fakeDocument() {
  const make = tag => ({tag, children: [], attributes: {}, listeners: {}, _text: '', hidden: false,
    set textContent(value) { this._text = String(value); this.children = []; }, get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
    set innerHTML(value) { throw new Error('innerHTML is not allowed: ' + value); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(...nodes) { for (const node of nodes) this.children.push(typeof node === 'string' ? Object.assign(make('#text'), {_text: node}) : node); },
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); },
    addEventListener(name, handler) { this.listeners[name] = handler; },
  });
  const doc = {createElement: make};
  const container = make('div'); container.ownerDocument = doc;
  return container;
}
const walk = (node, visit) => { visit(node); node.children.forEach(child => walk(child, visit)); };

test('hostile server text renders as text and never as markup', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const {transport} = recorder(() => json({modules: [{...module1, title: hostile, prerequisites: [hostile]}], knownModuleIds: []}));
  const controller = createImportReviewController({service: createLessonService(transport), source, filename: hostile});
  await controller.start();
  const container = fakeDocument();
  renderImportReview(container, controller.getState(), {onConfirm() {}, onCancel() {}});
  assert.ok(container.textContent.includes(hostile));
  walk(container, node => assert.ok(!/^(img|script|iframe|a)$/.test(node.tag), 'no element comes from server text'));
});

test('the rendered review wires Cancel and Confirm to the controller and shows errors', async () => {
  const {calls, transport} = recorder(url => url.endsWith('/preview') ? json(preview) : json({error: 'No.'}, 413));
  const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
  await controller.start();
  const container = fakeDocument();
  const draw = () => renderImportReview(container, controller.getState(), {onConfirm: () => controller.confirm().then(draw), onCancel: () => { controller.cancel(); draw(); }});
  draw();
  const buttons = [];
  walk(container, node => { if (node.tag === 'button') buttons.push(node); });
  const labels = buttons.map(button => button.textContent);
  assert.ok(labels.includes('Add these lessons'));
  assert.ok(labels.includes('Cancel'));
  await buttons.find(button => button.textContent === 'Add these lessons').listeners.click();
  assert.match(container.textContent, /too large/i);
  assert.ok(!/added/i.test(container.textContent), 'no success text after a failure');
  const alert = []; walk(container, node => { if (node.attributes.role === 'alert') alert.push(node); });
  assert.equal(alert.length, 1);

  const fresh = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
  await fresh.start();
  const callsBefore = calls.length;
  const box = fakeDocument();
  renderImportReview(box, fresh.getState(), {onConfirm() {}, onCancel: () => fresh.cancel()});
  const cancel = []; walk(box, node => { if (node.tag === 'button' && node.textContent === 'Cancel') cancel.push(node); });
  cancel[0].listeners.click();
  assert.equal(calls.length, callsBefore);
  assert.equal(fresh.getState().phase, 'cancelled');
});
