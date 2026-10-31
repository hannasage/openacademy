import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, readdir} from 'node:fs/promises';
import {createLessonService, LessonServiceError} from '../web/services/lessons.js';
import {classifyLessonFile, classifyLessonText, looksLikeLessonText} from '../web/screens/module-import-dialog.js';
import {
  buildImportReview, updateOffers, createImportReviewController, createPinSwitchController, renderImportReview, renderModuleList,
} from '../web/screens/module-import.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
/** A fake transport that records every call and answers by path. @param {(url:string,options:any)=>Response|Promise<Response>} answer */
function recorder(answer) {
  const calls = [];
  const transport = async (url, options = {}) => { calls.push({url, options}); return answer(url, options); };
  return {calls, transport};
}
const sha = 'a'.repeat(64);
/** One module entry the way the real preview route writes it. */
const module1 = {
  index: 0, name: 'intro.json', kind: 'module', id: 'intro', version: '1.0.0', title: 'Intro', sha256: sha, size: 1200, status: 'new',
  taskCount: 3, checkCount: 2, harness: true, license: {id: 'CC-BY-4.0'}, price: {amount: 1999, currency: 'USD'}, prerequisites: ['basics'],
  missingPrerequisites: ['basics'], pin: 'will-pin', pinnedVersion: null, newerVersionAvailable: null, state: 'new',
};
const preview = {importable: true, kind: 'module', files: [module1], modules: [module1], conflicts: [], problems: []};
const source = {schemaVersion: '1.0', id: 'intro', version: '1.0.0'};
const conflictPreview = {importable: false, kind: 'module', files: [], modules: [], conflicts: [{id: 'intro', version: '1.0.0'}],
  problems: [{file: 'intro.json', index: 0, id: 'intro', version: '1.0.0', code: 'version_conflict', status: 409, reason: 'conflict', errors: [{pointer: '', message: 'This id and version are already stored with different content.'}]}]};
const damagedPreview = {importable: false, kind: 'module', files: [], modules: [], conflicts: [],
  problems: [{file: 'broken.json', index: 0, code: 'invalid_lesson', status: 422, reason: 'invalid', errors: [{pointer: '', message: 'The file is not valid JSON.'}]}]};
const importResult = {imported: [{...module1, data: undefined}], revision: 1, modules: [{id: 'intro', title: 'Intro', pinnedVersion: '1.0.0', versions: ['1.0.0'], newerVersionAvailable: null}]};

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
  await service.switchPin('intro', '1.1.0', {confirm: true, expectedRevision: 1}); await service.exportLessons();
  await service.previewRestore({format: 'schola-lesson-backup'}); await service.restoreBackup({format: 'schola-lesson-backup'});
  await service.migrate();
  assert.deepEqual(calls.map(call => call.url), [
    '/api/lessons/import/preview', '/api/lessons/import', '/api/lessons', '/api/lessons/pins',
    '/api/lessons/export', '/api/lessons/import/preview', '/api/lessons/import', '/api/lessons/migrate',
  ]);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {});
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
  for (const expectedRevision of [undefined, null, '4', -1, 1.5, NaN]) {
    await assert.rejects(service.switchPin('intro', '1.1.0', {confirm: true, expectedRevision}), error => error instanceof LessonServiceError && error.code === 'expected_revision_required', String(expectedRevision));
  }
  assert.equal(calls.length, 0, 'a switch without the revision you read makes no call');
  await service.switchPin('intro', '1.1.0', {confirm: true, expectedRevision: 4});
  assert.deepEqual(JSON.parse(calls[0].options.body), {moduleId: 'intro', version: '1.1.0', confirm: true, expectedRevision: 4});
});

test('the source may be text, an object, or a list, and goes to the server as given', async () => {
  const {calls, transport} = recorder(() => json(preview));
  const service = createLessonService(transport);
  const text = '{"schemaVersion": "1.0", "id": "intro"}\n';
  await service.previewImport(text, 'a.json');
  await service.previewImport(source, 'a.json');
  await service.previewImport([text, source], 'bundle.json');
  await service.previewImport(source);
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body)), [
    {source: text, filename: 'a.json'}, {source, filename: 'a.json'}, {source: [text, source], filename: 'bundle.json'}, {source},
  ]);
});

test('server errors and network failures surface visible messages', async () => {
  const cases = [
    [422, 'invalid_lesson', 'invalid', /not a valid lesson/i],
    [422, 'missing_module', 'missing_module', /lesson set.*module.*not in/i],
    [409, 'version_conflict', 'conflict', /different content/i],
    [409, 'unsupported_version', 'unsupported_version', /newer.*version|not supported/i],
    [409, 'revision_conflict', 'revision_conflict', /changed|reload/i],
    [413, 'payload_too_large', 'too_large', /too large/i],
    [422, 'expected_revision_required', 'expected_revision_required', /revision/i],
    [400, 'invalid_request', 'request_failed', /could not finish/i],
  ];
  for (const [status, serverCode, code, pattern] of cases) {
    const service = createLessonService(async () => json({error: 'Server detail.', code: serverCode, retryable: false}, status));
    await assert.rejects(service.importLessons(source), error => error instanceof LessonServiceError && error.status === status && error.code === code && pattern.test(error.message) && error.detail === 'Server detail.', serverCode);
  }
  // A status alone never stands in for a code. Only a 413 with no code at all reads as too large.
  for (const status of [409, 422, 400, 500]) {
    await assert.rejects(createLessonService(async () => json({error: 'x'}, status)).importLessons(source),
      error => error.code === 'request_failed' && !/already exists|not a valid/i.test(error.message), `status ${status} without a code`);
  }
  await assert.rejects(createLessonService(async () => json({error: 'x'}, 413)).importLessons(source), error => error.code === 'too_large');
  await assert.rejects(createLessonService(async () => new Response('<html>too big</html>', {status: 413})).importLessons(source), error => error.code === 'too_large' && error.detail === '');
  await assert.rejects(createLessonService(async () => { throw new TypeError('Failed to fetch'); }).listLessons(), error => error.code === 'network_error' && /did not answer/.test(error.message));
  await assert.rejects(createLessonService(async () => new Response('<html>ok</html>')).listLessons(), error => error.code === 'invalid_response');
});

test('every code the lesson routes can answer with has its own words', async () => {
  const table = {
    invalid_lesson: [422, 'invalid', /not a valid lesson/i], missing_module: [422, 'missing_module', /module/i],
    version_conflict: [409, 'conflict', /different content/i], unsupported_version: [409, 'unsupported_version', /newer lesson format/i],
    revision_conflict: [409, 'revision_conflict', /changed/i], revision_limit: [409, 'revision_limit', /most changes/i],
    payload_too_large: [413, 'too_large', /too large/i], store_full: [413, 'store_full', /library is full/i],
    confirmation_required: [400, 'confirmation_required', /confirm/i], expected_revision_required: [422, 'expected_revision_required', /revision/i],
    identity_collision: [409, 'identity_collision', /same name/i], not_migrated: [409, 'not_migrated', /not prepared/i],
    rollback_incomplete: [500, 'rollback_incomplete', /could not fully undo/i], partial_restore: [500, 'partial_restore', /stopped part way/i],
    newer_than_snapshot: [409, 'newer_than_snapshot', /saved after the migration/i], corrupt_file: [500, 'corrupt_file', /damaged/i],
    unsafe_path: [500, 'unsafe_path', /unsafe path/i], not_found: [404, 'not_found', /could not find/i],
    storage_unavailable: [500, 'storage_unavailable', /data folder/i], request_timeout: [408, 'request_timeout', /too long/i],
    internal_error: [500, 'internal_error', /unexpected problem/i], forbidden_origin: [403, 'forbidden_origin', /own local address/i],
  };
  for (const [serverCode, [status, code, pattern]] of Object.entries(table)) {
    const failure = await createLessonService(async () => json({error: 'Detail.', code: serverCode, retryable: false}, status)).importLessons(source).catch(error => error);
    assert.ok(failure instanceof LessonServiceError, serverCode);
    assert.equal(failure.code, code, serverCode);
    assert.equal(failure.serverCode, serverCode);
    assert.match(failure.message, pattern, serverCode);
  }
});

test('a code the web side does not know shows a neutral message with that code', async () => {
  for (const status of [409, 422, 500]) {
    const failure = await createLessonService(async () => json({error: 'Odd.', code: 'brand_new_problem'}, status)).importLessons(source).catch(error => error);
    assert.equal(failure.code, 'request_failed');
    assert.match(failure.message, /could not finish this request \(code: brand_new_problem\)/);
    assert.doesNotMatch(failure.message, /already exists|not a valid|too large/i);
  }
  const hostile = await createLessonService(async () => json({error: 'x', code: '<img src=x onerror=alert(1)>'}, 409)).importLessons(source).catch(error => error);
  assert.doesNotMatch(hostile.message, /img/);
  assert.equal(hostile.serverCode, '');
  const plain = await createLessonService(async () => json({error: 'x', code: 'invalid_request'}, 400)).importLessons(source).catch(error => error);
  assert.equal(plain.message, 'The local server could not finish this request.');
});

test('a request over 5,000,000 bytes is refused on the client with both limits and no call', async () => {
  const {calls, transport} = recorder(() => json(preview));
  const service = createLessonService(transport);
  const big = 'x'.repeat(5_000_001);
  for (const call of [() => service.previewImport(big, 'a.json'), () => service.importLessons(big), () => service.previewRestore(big), () => service.restoreBackup(big)]) {
    await assert.rejects(call(), error => error instanceof LessonServiceError && error.code === 'too_large' && /5 MB/.test(error.message) && /2 MB/.test(error.message));
  }
  // The size is counted in bytes of the whole body. Escapes and four-byte characters count in full.
  const quotes = '"'.repeat(2_550_000) + 'a'.repeat(100_000);
  await assert.rejects(service.previewImport(quotes), error => error.code === 'too_large', 'each quote becomes two bytes');
  await assert.rejects(service.previewImport('\u{1F600}'.repeat(1_300_000)), error => error.code === 'too_large', 'four bytes each');
  assert.equal(calls.length, 0);
  await service.previewImport('x'.repeat(4_900_000));
  assert.equal(calls.length, 1);
});

test('an answer without a module list is not a preview or a listing', async () => {
  await assert.rejects(createLessonService(async () => json({importable: true})).previewImport(source), error => error.code === 'invalid_response');
  await assert.rejects(createLessonService(async () => json({importable: true})).previewRestore('x'), error => error.code === 'invalid_response');
  await assert.rejects(createLessonService(async () => json({revision: 1})).listLessons(), error => error.code === 'invalid_response');
  await assert.rejects(createLessonService(async () => json({revision: 1, modules: 'none'})).listLessons(), error => error.code === 'invalid_response');
  await assert.rejects(createLessonService(async () => json([])).listLessons(), error => error.code === 'invalid_response');
});

test('migrate posts an empty object and returns the server status', async () => {
  const {calls, transport} = recorder(() => json({status: 'migrated', records: 1, snapshots: 1, files: 14}));
  const result = await createLessonService(transport).migrate();
  assert.deepEqual(result, {status: 'migrated', records: 1, snapshots: 1, files: 14});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/lessons/migrate');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  const again = await createLessonService(async () => json({status: 'already-migrated'})).migrate();
  assert.equal(again.status, 'already-migrated');
});

test('server text is cleaned and capped before it becomes a detail', async () => {
  const noisy = '\u0000\u202Eevil\n' + 'x'.repeat(1000);
  const service = createLessonService(async () => json({error: noisy}, 422));
  await assert.rejects(service.previewImport(source), error => error.detail.length <= 300 && !/[\p{Cc}\p{Cf}]/u.test(error.detail));
});

test('the review lists what an import would add, read only', () => {
  const next = {...module1, index: 1, id: 'next', version: '2.0.0', title: 'Next', state: 'present', status: 'already-stored', prerequisites: [], missingPrerequisites: [], pin: 'kept', pinnedVersion: '2.0.0'};
  const model = buildImportReview({importable: true, kind: 'packet', packetTitle: 'Starter', files: [{kind: 'packet', id: 'starter', version: '1.0.0', title: 'Starter', status: 'new'}, module1, next], modules: [module1, next], conflicts: [], problems: []}, {filename: 'pack.json'});
  assert.match(model.heading, /Starter/);
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
  assert.match(first.pinText, /would use this version/i);
  assert.match(second.pinText, /keep using version 2\.0\.0/i);
  assert.equal(model.canConfirm, true);
  assert.equal(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A', state: 'present'}]}).canConfirm, false);
  assert.match(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A'}]}).items[0].price, /no price/i);
  assert.equal(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A', price: {amount: 0, currency: 'USD'}}]}).items[0].price, 'Free');
  assert.match(buildImportReview({modules: [{id: 'a', version: '1.0.0', title: 'A'}]}).items[0].harness, /no tutor harness/i);
});

test('the server decides which prerequisites are missing', () => {
  const none = buildImportReview({modules: [{...module1, missingPrerequisites: []}]});
  assert.deepEqual(none.items[0].warnings, []);
  const one = buildImportReview({modules: [module1]});
  assert.equal(one.items[0].warnings.length, 1);
  assert.match(one.items[0].warnings[0], /"basics"/);
  const bare = {...module1}; delete bare.missingPrerequisites;
  assert.ok(buildImportReview({modules: [bare]}).items[0].warnings.some(text => /basics/.test(text)), 'an older answer falls back to the import itself');
  assert.deepEqual(buildImportReview({modules: [bare, {id: 'basics', version: '1.0.0', title: 'Basics'}]}).items[0].warnings, []);
});

test('a same-id different-bytes conflict is flagged and blocks the confirm step', () => {
  const model = buildImportReview(conflictPreview);
  assert.equal(model.canConfirm, false);
  assert.deepEqual(model.items, []);
  assert.match(model.conflicts[0], /intro/);
  assert.match(model.conflicts[0], /will not replace/i);
  assert.match(model.summary, /nothing was changed/i);
  assert.deepEqual(model.problems, [], 'a conflict is listed once, under its own heading');
  const mixedProblems = buildImportReview({...conflictPreview, problems: [...conflictPreview.problems, ...damagedPreview.problems]});
  assert.equal(mixedProblems.conflicts.length, 1);
  assert.equal(mixedProblems.problems.length, 1, 'a different problem is still listed');
  assert.equal(buildImportReview({...preview, conflicts: [{id: 'intro', version: '1.0.0'}]}).canConfirm, false);
  assert.equal(buildImportReview({modules: [{...module1, state: 'conflict'}]}).items[0].state, 'conflict');
});

test('a damaged or invalid file lists the server problems and blocks the confirm step', () => {
  const model = buildImportReview(damagedPreview);
  assert.equal(model.canConfirm, false);
  assert.equal(model.problems.length, 1);
  assert.match(model.problems[0], /broken\.json/);
  assert.match(model.problems[0], /not valid JSON/);
  assert.match(model.summary, /nothing was changed/i);
  const mixed = buildImportReview({...preview, importable: false, problems: damagedPreview.problems});
  assert.equal(mixed.canConfirm, false, 'a preview that says importable false never confirms');
  const hostile = buildImportReview({...damagedPreview, problems: [{file: '\u202Ea\n.json', errors: [{message: 'x'.repeat(900)}]}]});
  assert.ok(hostile.problems[0].length < 500 && !/[\p{Cc}\p{Cf}]/u.test(hostile.problems[0]));
});

test('a packet whose modules are already stored can still be confirmed', () => {
  const stored = {...module1, state: 'present', status: 'already-stored', pin: 'kept', pinnedVersion: '1.0.0'};
  const model = buildImportReview({importable: true, kind: 'packet', packetTitle: 'Set', files: [{kind: 'packet', id: 'set', version: '1.0.0', title: 'Set', status: 'new'}, stored], modules: [stored], conflicts: [], problems: []});
  assert.equal(model.canConfirm, true);
  const nothing = buildImportReview({importable: true, kind: 'module', files: [stored], modules: [stored], conflicts: [], problems: []});
  assert.equal(nothing.canConfirm, false);
});

test('a newer version in the preview becomes an offer and nothing else', () => {
  const newer = {...module1, version: '1.1.0', state: 'new', pin: 'newer-than-pin', pinnedVersion: '1.0.0', newerVersionAvailable: '1.1.0'};
  const model = buildImportReview({importable: true, kind: 'module', files: [newer], modules: [newer], conflicts: [], problems: []});
  assert.match(model.items[0].pinText, /keep using version 1\.0\.0/i);
  assert.equal(model.items[0].offer.toVersion, '1.1.0');
  assert.match(model.items[0].offer.text, /nothing changes unless you choose/i);
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
  const {calls, transport} = recorder(url => json(url.endsWith('/preview') ? preview : importResult));
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
  assert.match(state.message.text, /Added 1 lesson/);
  assert.equal(state.result.revision, 1);
  assert.equal(state.result.modules[0].id, 'intro');
});

test('the added count skips files that were already stored and counts a lone packet', async () => {
  const stored = {...module1, status: 'already-stored'};
  const packet = {kind: 'packet', id: 'set', version: '1.0.0', title: 'Set', status: 'new'};
  for (const [imported, pattern] of [[[stored, module1], /Added 1 lesson\./], [[packet, stored], /Added the lesson set/], [[packet, module1, {...module1, id: 'two'}], /Added 2 lessons/]]) {
    const {transport} = recorder(url => json(url.endsWith('/preview') ? preview : {imported, revision: 3, modules: []}));
    const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
    await controller.start(); await controller.confirm();
    assert.match(controller.getState().message.text, pattern);
  }
});

test('confirm before the preview, or over a conflict, makes no import call', async () => {
  const early = recorder(() => json(preview));
  const idle = createImportReviewController({service: createLessonService(early.transport), source, filename: 'a.json'});
  assert.equal(await idle.confirm(), false);
  assert.equal(early.calls.length, 0);

  const conflict = recorder(() => json(conflictPreview));
  const blocked = createImportReviewController({service: createLessonService(conflict.transport), source, filename: 'a.json'});
  await blocked.start();
  assert.equal(await blocked.confirm(), false);
  assert.deepEqual(conflict.calls.map(call => call.url), ['/api/lessons/import/preview']);
  assert.equal(blocked.getState().phase, 'reviewing');
});

test('a failed import never claims success and shows the server problem', async () => {
  for (const [status, serverCode, pattern] of [[409, 'version_conflict', /different content/i], [413, 'payload_too_large', /too large/i], [422, 'invalid_lesson', /not a valid/i], [422, 'missing_module', /module/i]]) {
    const {transport} = recorder(url => url.endsWith('/preview') ? json(preview) : json({error: 'Nope.', code: serverCode}, status));
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
  const {transport} = recorder(() => json({error: 'Bad file.', code: 'invalid_lesson'}, 422));
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
  assert.equal(again.getState().listing.revision, 4, 'the new listing is kept for the screen');
});

test('a failed pin switch never claims success', async () => {
  const offer = {moduleId: 'intro', title: 'Intro', fromVersion: '1.0.0', toVersion: '1.1.0', text: ''};
  const controller = createPinSwitchController({service: createLessonService(async () => json({error: 'Revision moved.', code: 'revision_conflict'}, 409)), offer});
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
  const {calls, transport} = recorder(url => url.endsWith('/preview') ? json(preview) : json({error: 'No.', code: 'payload_too_large'}, 413));
  const controller = createImportReviewController({service: createLessonService(transport), source, filename: 'a.json'});
  await controller.start();
  const container = fakeDocument();
  const draw = () => renderImportReview(container, controller.getState(), {onConfirm: () => controller.confirm().then(draw), onCancel: () => { controller.cancel(); draw(); }});
  draw();
  const buttons = [];
  walk(container, node => { if (node.tag === 'button') buttons.push(node); });
  const labels = buttons.map(button => button.textContent);
  assert.ok(labels.includes('Add these lessons'));
  assert.ok(container.textContent.includes('Schola would use this version'));
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

test('the module list offers a newer version in two steps and never switches on its own', () => {
  const listing = {revision: 3, modules: [
    {id: 'intro', title: '<b>Intro</b>', versions: ['1.0.0', '1.1.0'], pinnedVersion: '1.0.0', newerVersionAvailable: '1.1.0'},
    {id: 'other', title: 'Other', versions: ['1.0.0'], pinnedVersion: '1.0.0', newerVersionAvailable: null},
  ]};
  const offer = updateOffers(listing)[0];
  const clicks = [];
  const actions = {onReview: id => clicks.push(['review', id]), onConfirm: id => clicks.push(['confirm', id]), onDecline: id => clicks.push(['decline', id]), onClose: () => clicks.push(['close'])};
  const labels = container => { const found = []; walk(container, node => { if (node.tag === 'button') found.push(node); }); return found; };

  const offered = fakeDocument();
  renderModuleList(offered, {listing, switches: {}, message: {kind: 'success', text: 'Added 1 lesson.'}}, actions);
  assert.ok(offered.textContent.includes('<b>Intro</b>'), 'the title is text');
  assert.match(offered.textContent, /Added 1 lesson/);
  assert.match(offered.textContent, /Nothing changes unless you choose to switch/);
  assert.deepEqual(labels(offered).map(button => button.textContent), ['Review the switch', 'Close']);
  walk(offered, node => assert.ok(!/^(b|img|script|iframe|a)$/.test(node.tag)));
  labels(offered)[0].listeners.click();
  assert.deepEqual(clicks, [['review', 'intro']]);

  const confirming = fakeDocument();
  renderModuleList(confirming, {listing, switches: {intro: {phase: 'confirming', offer, message: {kind: 'info', text: 'Switch "Intro" from version 1.0.0 to version 1.1.0? You can switch back later.'}}}, message: null}, actions);
  assert.deepEqual(labels(confirming).map(button => button.textContent), ['Switch to version 1.1.0', 'Keep version 1.0.0', 'Close']);
  labels(confirming)[1].listeners.click(); labels(confirming)[0].listeners.click();
  assert.deepEqual(clicks.slice(1), [['decline', 'intro'], ['confirm', 'intro']]);

  const empty = fakeDocument();
  renderModuleList(empty, {listing: {revision: 0, modules: []}, switches: {}, message: null}, actions);
  assert.match(empty.textContent, /no imported lessons/i);
});

test('a chosen file goes to the lesson review only when it is a lesson file', async () => {
  const folder = new URL('./fixtures/contracts/valid/', import.meta.url);
  const read = async name => JSON.parse(await readFile(new URL(name, folder), 'utf8'));
  assert.equal(classifyLessonFile(await read('lesson-module-minimal.json')), 'lesson');
  assert.equal(classifyLessonFile(await read('packet-one-module.json')), 'lesson');
  assert.equal(classifyLessonFile([await read('packet-one-module.json'), await read('lesson-module-minimal.json')]), null, 'a list in one file is not a lesson file, because its parts have no exact bytes of their own');
  assert.equal(classifyLessonText(await readFile(new URL('lesson-module-minimal.json', folder), 'utf8')), 'lesson');
  assert.equal(classifyLessonText('{"schemaVersion": "1.0", "id": "a", "ti'), 'lesson', 'a damaged lesson file still goes to the server for a plain explanation');
  assert.equal(classifyLessonText('{"id": "my-course", "tit'), null);
  assert.equal(classifyLessonText('{"format": "schola-lesson-backup", "schemaVersion": "1.0"}'), 'backup');
  assert.equal(classifyLessonFile({format: 'schola-lesson-backup', version: 1}), 'backup');
  assert.equal(classifyLessonFile({schemaVersion: '9.0', id: 'x'}), 'lesson', 'an unknown major version still goes to the server, which explains the refusal');
  // Every curriculum, progress backup, and record example keeps the older review.
  for (const name of (await readdir(folder)).filter(entry => entry.endsWith('.json') && !/^(lesson-module|packet|help-record)/.test(entry))) {
    assert.equal(classifyLessonFile(await read(name)), null, name);
  }
  for (const value of [null, 5, 'text', [], [1], [{schemaVersion: '1.0'}, {}], {schemaVersion: 1}]) assert.equal(classifyLessonFile(value), null);
  assert.equal(looksLikeLessonText('{"schemaVersion": "1.0", "id": "a", "ti'), true);
  assert.equal(looksLikeLessonText('{"id": "my-course", "title": "A curricul'), false);
});
