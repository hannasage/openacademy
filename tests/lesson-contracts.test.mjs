import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  LESSON_CONTRACT_KINDS,
  MAX_BYTES,
  packetFromModule,
  validateLessonContract,
  validateLessonFile,
  validateLessonText,
} from '../contracts/validate.mjs';

const root = new URL('../', import.meta.url);
const fixtureRoot = new URL('tests/fixtures/contracts/', root);
const readText = (url) => readFile(url, 'utf8');
const readJSON = async (url) => JSON.parse(await readText(url));
const fixture = (relative) => new URL(relative, fixtureRoot);
const manifest = await readJSON(fixture('lesson-conformance.json'));

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const load = async (file) => readJSON(fixture(file));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LADDER = ['nudge', 'question', 'partial-example', 'full-answer'];

const expectedFor = (entry) => (entry.expect === 'valid'
  ? { ok: true }
  : { ok: false, reason: entry.expect.slice('invalid:'.length) });

// Schema-only validation, to prove that each fixture fails at the stage the manifest names.
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const name of (await readdir(new URL('contracts/', root))).filter((file) => file.endsWith('.schema.json'))) {
  ajv.addSchema(await readJSON(new URL(`contracts/${name}`, root)));
}
const schemaFor = (kind) => ajv.getSchema(`urn:schola:contract:${kind}:v1`);

test('the manifest covers every kind and every fixture file, and nothing else', async () => {
  assert.deepEqual([...LESSON_CONTRACT_KINDS].sort(), ['help-record', 'lesson-module', 'packet']);
  const listed = new Set(manifest.map((entry) => entry.file));
  assert.equal(listed.size, manifest.length, 'a file is listed twice');
  const names = new Set(manifest.map((entry) => entry.name));
  assert.equal(names.size, manifest.length, 'a name is listed twice');
  // Every file in valid/ and invalid/ must belong to the older cases or to this manifest.
  const older = new Set((await readJSON(fixture('cases.json'))).map((entry) => entry.file));
  const onDisk = new Set();
  for (const folder of ['valid', 'invalid']) {
    for (const name of await readdir(fixture(`${folder}/`))) onDisk.add(`${folder}/${name}`);
  }
  for (const file of listed) assert.equal(older.has(file), false, `${file} is also an older case`);
  assert.deepEqual([...onDisk].filter((file) => !older.has(file)).sort(), [...listed].sort());
  for (const file of older) assert.ok(onDisk.has(file), `${file} is listed in cases.json but missing`);
  for (const entry of manifest) {
    assert.ok(LESSON_CONTRACT_KINDS.includes(entry.kind), entry.name);
    assert.match(entry.expect, /^(valid|invalid:(invalid|unsupported_version))$/, entry.name);
    const stageReason = { none: 'valid', parse: 'invalid:invalid', schema: 'invalid:invalid', semantic: 'invalid:invalid', version: 'invalid:unsupported_version' };
    assert.equal(entry.expect, stageReason[entry.stage], `${entry.name}: stage and expectation disagree`);
    assert.match(entry.stage, /^(none|parse|version|schema|semantic)$/, entry.name);
    assert.equal(entry.file.startsWith(entry.expect === 'valid' ? 'valid/' : 'invalid/'), true, entry.name);
  }
});

for (const entry of manifest) {
  test(`lesson conformance: ${entry.name}`, async () => {
    const text = await readText(fixture(entry.file));
    const result = validateLessonText(entry.kind, text);
    assert.equal(result.ok, expectedFor(entry).ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.reason, expectedFor(entry).reason, JSON.stringify(result));
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
      for (const error of result.errors) {
        assert.equal(typeof error.pointer, 'string');
        assert.equal(typeof error.message, 'string');
        assert.deepEqual(Object.keys(error).sort(), ['message', 'pointer']);
      }
    } else {
      assert.deepEqual(Object.keys(result), ['ok']);
    }
    if (entry.stage === 'semantic') {
      assert.equal(schemaFor(entry.kind)(JSON.parse(text)), true, 'a semantic case must pass the schema');
    }
    if (entry.stage === 'schema') {
      assert.equal(schemaFor(entry.kind)(JSON.parse(text)), false, 'a schema case must fail the schema');
    }
    if (entry.stage === 'none') {
      assert.equal(schemaFor(entry.kind)(JSON.parse(text)), true);
    }
    if (entry.stage === 'parse') {
      assert.throws(() => JSON.parse(text), SyntaxError, 'a parse case must not be valid JSON');
    } else {
      assert.doesNotThrow(() => JSON.parse(text), `${entry.name} must be valid JSON`);
    }
    if (entry.stage === 'version') {
      const marker = JSON.parse(text).schemaVersion;
      assert.equal(typeof marker, 'string');
      assert.notEqual(Number(/^(\d+)\./.exec(marker)?.[1]), 1, 'a version case must name an unsupported major');
      assert.equal(result.reason, 'unsupported_version');
    }
  });
}

test('the validator never changes a document, even a frozen one', async () => {
  for (const entry of manifest) {
    if (entry.stage === 'parse') continue;
    const document = await load(entry.file);
    const copy = structuredClone(document);
    const result = validateLessonContract(entry.kind, deepFreeze(document));
    assert.equal(result.ok, entry.expect === 'valid', entry.name);
    assert.deepEqual(document, copy, entry.name);
  }
});

test('a damaged file and an unsupported major version are rejected and left untouched', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'schola-lesson-'));
  try {
    const cases = manifest.filter((entry) => entry.expect === 'invalid:unsupported_version'
      || entry.stage === 'parse');
    assert.ok(cases.some((entry) => entry.stage === 'parse'));
    assert.ok(cases.some((entry) => entry.expect === 'invalid:unsupported_version'));
    for (const entry of cases) {
      const target = path.join(folder, path.basename(entry.file));
      await copyFile(new URL(entry.file, fixtureRoot), target);
      const old = new Date('2020-01-02T03:04:05Z');
      await utimes(target, old, old);
      const before = await stat(target);
      const bytes = await readFile(target);
      const result = await validateLessonFile(entry.kind, target);
      assert.equal(result.ok, false);
      assert.equal(result.reason, entry.expect.slice('invalid:'.length));
      const after = await stat(target);
      assert.equal(after.mtimeMs, before.mtimeMs, `${entry.name} mtime`);
      assert.equal(after.size, before.size);
      assert.equal(sha(await readFile(target)), sha(bytes), `${entry.name} bytes`);
    }
    const listing = await readdir(folder);
    assert.deepEqual(listing.sort(), cases.map((entry) => path.basename(entry.file)).sort(), 'no file was created or removed');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('the repository fixtures are not changed by a run over the whole manifest', async () => {
  const stamp = async () => Promise.all(manifest.map(async (entry) => {
    const url = fixture(entry.file);
    const info = await stat(url);
    return [entry.file, info.mtimeMs, info.size, sha(await readFile(url))];
  }));
  const before = await stamp();
  for (const entry of manifest) await validateLessonFile(entry.kind, new URL(entry.file, fixtureRoot).pathname);
  assert.deepEqual(await stamp(), before);
});

test('an unknown kind and a non-object document are invalid results', async () => {
  assert.equal(validateLessonContract('module', {}).ok, false);
  assert.equal(validateLessonContract('module', {}).reason, 'invalid');
  for (const value of [null, undefined, 3, 'text', [], true]) {
    const result = validateLessonContract('packet', value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
  }
});

test('only a major version of 1 is supported, and it is checked before any other field', async () => {
  const base = await load('valid/packet-one-module.json');
  for (const marker of ['2.0', '0.9', '10.0', '2.5', '1000.0', '2.0.0', '1000000.0', '9999999.1.2', '99999999999999999999.0']) {
    const result = validateLessonContract('packet', { ...base, schemaVersion: marker });
    assert.equal(result.reason, 'unsupported_version', marker);
    assert.deepEqual(result.errors.map((error) => error.pointer), ['/schemaVersion']);
  }
  for (const marker of ['1', '1.', '1.x', 'v1.0', 1, 1.0, null, '', '01.0', '1.0.0']) {
    const result = validateLessonContract('packet', { ...base, schemaVersion: marker });
    assert.equal(result.ok, false, String(marker));
    assert.equal(result.reason, 'invalid', String(marker));
  }
  assert.equal(validateLessonContract('packet', { ...base, schemaVersion: '1.0' }).ok, true);
  assert.equal(validateLessonContract('packet', { ...base, schemaVersion: '1.7' }).ok, true);
  const { schemaVersion, ...unmarked } = base;
  assert.equal(schemaVersion, '1.0');
  assert.equal(validateLessonContract('packet', unmarked).reason, 'invalid');
});

test('a lesson module becomes a valid one-entry packet without changing the module', async () => {
  for (const file of ['valid/lesson-module-minimal.json', 'valid/lesson-module-full.json']) {
    const module = await load(file);
    const copy = structuredClone(module);
    const packet = packetFromModule(deepFreeze(module));
    assert.deepEqual(module, copy);
    assert.equal(packet.modules.length, 1);
    assert.deepEqual(packet.modules[0], { id: module.id, version: module.version });
    assert.equal(packet.id, module.id);
    assert.equal(packet.version, module.version);
    assert.equal(packet.title, module.title);
    assert.deepEqual(validateLessonContract('packet', packet), { ok: true });
  }
});

test('module semantic rules reject duplicate ids, dangling checks, and a self prerequisite', async () => {
  const full = await load('valid/lesson-module-full.json');
  const fail = (mutate, pointer) => {
    const next = structuredClone(full);
    mutate(next);
    const result = validateLessonContract('lesson-module', next);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
    assert.ok(result.errors.some((error) => error.pointer === pointer), JSON.stringify(result.errors));
  };
  fail((next) => { next.tasks[1].id = next.tasks[0].id; }, '/tasks/1/id');
  fail((next) => { next.checks[1].id = next.checks[0].id; }, '/checks/1/id');
  fail((next) => { next.blocks[1].id = next.blocks[0].id; }, '/blocks/1/id');
  const referenceIndex = full.blocks.findIndex((block) => block.type === 'check-reference');
  fail((next) => { next.blocks[referenceIndex].checkId = 'no-such-check'; }, `/blocks/${referenceIndex}/checkId`);
  fail((next) => { next.prerequisites.push(next.id); }, `/prerequisites/${full.prerequisites.length}`);
});

test('the hint ladder must hold the four levels in order', async () => {
  const full = await load('valid/lesson-module-full.json');
  assert.deepEqual(full.tasks[0].hints.map((hint) => hint.level), LADDER);
  const orders = [
    ['question', 'nudge', 'partial-example', 'full-answer'],
    ['full-answer', 'partial-example', 'question', 'nudge'],
    ['nudge', 'nudge', 'partial-example', 'full-answer'],
    ['nudge', 'question', 'full-answer', 'partial-example'],
  ];
  for (const order of orders) {
    const next = structuredClone(full);
    next.tasks[0].hints = order.map((level) => ({ level, text: `Text for ${level}.` }));
    const result = validateLessonContract('lesson-module', next);
    assert.equal(result.reason, 'invalid', order.join());
    assert.ok(result.errors.some((error) => error.pointer.startsWith('/tasks/0/hints')), order.join());
  }
  for (const length of [0, 1, 2, 3, 5]) {
    const next = structuredClone(full);
    next.tasks[0].hints = Array.from({ length }, (_, index) => ({ level: LADDER[index % 4], text: 'Text.' }));
    assert.equal(validateLessonContract('lesson-module', next).ok, false, `length ${length}`);
  }
});

test('module objects are closed except the check runner descriptor', async () => {
  const full = await load('valid/lesson-module-full.json');
  const targets = [
    (next) => next,
    (next) => next.blocks[0],
    (next) => next.blocks.find((block) => block.type === 'source-link'),
    (next) => next.blocks.find((block) => block.type === 'interactive-code'),
    (next) => next.blocks.find((block) => block.type === 'check-reference'),
    (next) => next.tasks[0],
    (next) => next.tasks[0].hints[0],
    (next) => next.checks[0],
    (next) => next.harness,
    (next) => next.license,
    (next) => next.price,
  ];
  targets.forEach((pick, index) => {
    const next = structuredClone(full);
    pick(next).unexpected = true;
    assert.equal(validateLessonContract('lesson-module', next).ok, false, `target ${index}`);
  });
  const next = structuredClone(full);
  const automated = next.checks.find((check) => check.kind === 'automated');
  automated.runner.futureOption = 'text';
  automated.runner.retries = 3;
  automated.runner.strict = true;
  automated.runner.allowedHosts = ['a.example.org', 'b.example.org'];
  assert.equal(validateLessonContract('lesson-module', next).ok, true);
});

test('a runner descriptor is flat data with safe keys and bounded values', async () => {
  const full = await load('valid/lesson-module-full.json');
  const withRunner = (runner) => {
    const next = structuredClone(full);
    next.checks.find((check) => check.kind === 'automated').runner = runner;
    return validateLessonContract('lesson-module', next).ok;
  };
  assert.equal(withRunner({ type: 'script' }), true);
  assert.equal(withRunner({ type: 'script', nested: { any: ['shape'] } }), false, 'nested object');
  assert.equal(withRunner({ type: 'script', list: [{ a: 1 }] }), false, 'array of objects');
  assert.equal(withRunner({ type: 'script', list: [1, 2] }), false, 'array of numbers');
  assert.equal(withRunner({ type: 'script', empty: null }), false, 'null value');
  assert.equal(withRunner({ type: 'script', ratio: 1.5 }), false, 'fraction');
  assert.equal(withRunner({ type: 'script', big: 2 ** 40 }), false, 'unbounded integer');
  assert.equal(withRunner({ type: 'script', text: 'x'.repeat(501) }), false, 'long string');
  assert.equal(withRunner({ type: 'script', text: 'x'.repeat(500) }), true);
  assert.equal(withRunner({ type: 'script', list: Array.from({ length: 21 }, () => 'a') }), false, 'long array');
  assert.equal(withRunner({ type: 'script', list: ['x'.repeat(201)] }), false, 'long array item');
  const many = { type: 'script' };
  for (let index = 0; index < 20; index += 1) many[`key${index}`] = 'v';
  assert.equal(withRunner(many), false, '21 properties');
  for (const key of ['constructor', 'prototype', 'Upper', '1digit', 'has-dash', 'under_score', `a${'b'.repeat(40)}`, '']) {
    assert.equal(withRunner({ type: 'script', [key]: 'x' }), false, `key ${key}`);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const parsed = JSON.parse(`{"type":"script","${key}":"x"}`);
    assert.equal(withRunner(parsed), false, `parsed ${key}`);
  }
});

test('text fields need a visible character, not just whitespace or zero-width marks', async () => {
  const full = await load('valid/lesson-module-full.json');
  const hidden = ['', ' ', '\n\t', '\u200B', '\u200C\u200D', '\u2060', '\uFEFF', ' \u200B\uFEFF\u2060 '];
  const spots = [
    (next, value) => { next.title = value; },
    (next, value) => { next.outcome = value; },
    (next, value) => { next.tasks[0].prompt = value; },
    (next, value) => { next.blocks[0].body = value; },
    (next, value) => { next.checks[0].description = value; },
    (next, value) => { next.blocks[1].title = value; },
  ];
  spots.forEach((set, index) => {
    for (const value of hidden) {
      const next = structuredClone(full);
      set(next, value);
      assert.equal(validateLessonContract('lesson-module', next).ok, false, `spot ${index} ${JSON.stringify(value)}`);
    }
    const next = structuredClone(full);
    set(next, '\u200BReal text\u200B');
    assert.equal(validateLessonContract('lesson-module', next).ok, true, `spot ${index} with visible text`);
  });
  const packet = await load('valid/packet-one-module.json');
  assert.equal(validateLessonContract('packet', { ...packet, title: '\u200B' }).ok, false);
});

test('source links reject user information, control characters, and bidi overrides', async () => {
  const full = await load('valid/lesson-module-full.json');
  const link = full.blocks.findIndex((block) => block.type === 'source-link');
  const attempt = (url) => {
    const next = structuredClone(full);
    next.blocks[link].url = url;
    return validateLessonContract('lesson-module', next).ok;
  };
  for (const url of ['https://example.org/a@b', 'https://example.org/?mail=a@b.example', 'https://example.org#@x',
    'http://example.org:8080/path', 'https://example.org/caf%C3%A9', 'https://example.org/\u00E9']) {
    assert.equal(attempt(url), true, url);
  }
  const bad = ['https://user:pass@example.org/', 'https://user@example.org', 'http://@example.org/', 'https://a.example.org\\@evil.example/',
    'ftp://example.org/', 'javascript:alert(1)', 'https:example.org', 'https://example.org/a b', '',
    'https://example.org/\u0000', 'https://example.org/\u0001', 'https://example.org/\u001F', 'https://example.org/\u007F',
    'https://example.org/\n', 'https://exam\tple.org/', 'https://example.org/\u202E', 'https://example.org/\u202A', 'https://example.org/\u2066',
    'https://example.org/\u2069', 'https://ex\u202Eample.org/'];
  for (const url of bad) assert.equal(attempt(url), false, JSON.stringify(url));
  const license = structuredClone(full);
  license.license.url = 'https://user:pass@example.org/';
  assert.equal(validateLessonContract('lesson-module', license).ok, false);
});

test('a harness lists only the permissions of the tutor call surface', async () => {
  const full = await load('valid/lesson-module-full.json');
  const allowed = ['get_lesson', 'get_attempt', 'run_check', 'request_hint', 'log_reflection'];
  const next = structuredClone(full);
  next.harness.requiredPermissions = [];
  assert.equal(validateLessonContract('lesson-module', next).ok, true);
  next.harness.requiredPermissions = allowed;
  assert.equal(validateLessonContract('lesson-module', next).ok, true);
  for (const bad of ['write_file', 'network', 'mark_complete', '*', 'RUN_CHECK', '']) {
    next.harness.requiredPermissions = ['get_lesson', bad];
    assert.equal(validateLessonContract('lesson-module', next).ok, false, bad);
  }
  next.harness.requiredPermissions = ['get_lesson', 'get_lesson'];
  assert.equal(validateLessonContract('lesson-module', next).ok, false, 'duplicates');
  delete next.harness.requiredPermissions;
  assert.equal(validateLessonContract('lesson-module', next).ok, false, 'list is required');
  delete next.harness;
  assert.equal(validateLessonContract('lesson-module', next).ok, true, 'a harness is optional');
});

test('price uses an ISO currency code and whole minor units', async () => {
  const full = await load('valid/lesson-module-full.json');
  const attempt = (price) => validateLessonContract('lesson-module', { ...structuredClone(full), price }).ok;
  assert.equal(attempt({ amount: 0, currency: 'USD' }), true);
  assert.equal(attempt({ amount: 1999, currency: 'EUR' }), true);
  assert.equal(attempt({ amount: 99999999, currency: 'JPY' }), true);
  for (const price of [
    { amount: 19.99, currency: 'USD' }, { amount: -1, currency: 'USD' }, { amount: '1999', currency: 'USD' },
    { amount: 1999, currency: 'usd' }, { amount: 1999, currency: 'US' }, { amount: 1999, currency: 'DOLLARS' },
    { amount: 1999 }, { currency: 'USD' }, { amount: 9007199254740992, currency: 'USD' }, { amount: 100000000, currency: 'USD' }, null,
  ]) {
    assert.equal(attempt(price), false, JSON.stringify(price));
  }
});

test('check descriptors carry a runner only when the check is automated', async () => {
  const full = await load('valid/lesson-module-full.json');
  const next = structuredClone(full);
  const self = next.checks.find((check) => check.kind === 'self-reported');
  self.runner = { type: 'script' };
  assert.equal(validateLessonContract('lesson-module', next).ok, false, 'self-reported with a runner');
  const next2 = structuredClone(full);
  delete next2.checks.find((check) => check.kind === 'automated').runner;
  assert.equal(validateLessonContract('lesson-module', next2).ok, false, 'automated without a runner');
  const next3 = structuredClone(full);
  next3.checks.find((check) => check.kind === 'automated').runner = {};
  assert.equal(validateLessonContract('lesson-module', next3).ok, false, 'empty runner');
  const next4 = structuredClone(full);
  next4.checks.find((check) => check.kind === 'automated').runner = 'node check.js';
  assert.equal(validateLessonContract('lesson-module', next4).ok, false, 'runner is an object');
});

test('packet module ids are unique and every reference pins an exact version', async () => {
  const packet = await load('valid/packet-multi-module.json');
  const duplicate = structuredClone(packet);
  duplicate.modules[2] = { id: duplicate.modules[0].id, version: '9.9.9' };
  const result = validateLessonContract('packet', duplicate);
  assert.equal(result.reason, 'invalid');
  assert.ok(result.errors.some((error) => error.pointer === '/modules/2/id'));
  for (const version of ['^1.0.0', '~1.0.0', '1.0', '1', 'latest', '1.0.0-beta.1', '*', 1, '']) {
    const next = structuredClone(packet);
    next.modules[0].version = version;
    assert.equal(validateLessonContract('packet', next).ok, false, String(version));
  }
  const reordered = structuredClone(packet);
  reordered.modules.reverse();
  assert.equal(validateLessonContract('packet', reordered).ok, true, 'order is data, not a constraint');
});

test('help records follow the unlock rule for each level', async () => {
  const base = await load('valid/help-record-full-answer-agent.json');
  const record = (level, attemptId) => ({ ...base, level, attemptId });
  assert.equal(validateLessonContract('help-record', record('nudge', null)).ok, true);
  assert.equal(validateLessonContract('help-record', record('question', null)).ok, true);
  assert.equal(validateLessonContract('help-record', record('nudge', 'attempt-1')).ok, true);
  assert.equal(validateLessonContract('help-record', record('partial-example', 'attempt-1')).ok, true);
  assert.equal(validateLessonContract('help-record', record('full-answer', 'attempt-1')).ok, true);
  for (const level of ['partial-example', 'full-answer']) {
    const result = validateLessonContract('help-record', record(level, null));
    assert.equal(result.ok, false, level);
    assert.equal(result.reason, 'invalid');
  }
  for (const level of ['hint', 'Nudge', 'answer', '', null, 1]) {
    assert.equal(validateLessonContract('help-record', record(level, 'attempt-1')).ok, false, String(level));
  }
  for (const source of ['student', 'agent']) {
    assert.equal(validateLessonContract('help-record', { ...base, source }).ok, true, source);
  }
  for (const source of ['tutor', 'Student', '', null, undefined]) {
    assert.equal(validateLessonContract('help-record', { ...base, source }).ok, false, String(source));
  }
  const { attemptId, ...missing } = base;
  assert.ok(attemptId);
  assert.equal(validateLessonContract('help-record', missing).ok, false, 'attemptId is required, even when null');
});

test('help record timestamps are RFC 3339 and name a real moment', async () => {
  const base = await load('valid/help-record-nudge-null-attempt.json');
  const good = ['2026-11-01T09:30:00Z', '2026-11-01T09:30:00.123Z', '2026-11-01T09:30:00+02:00',
    '2026-11-01T09:30:00-05:30', '2028-02-29T23:59:59Z'];
  for (const timestamp of good) {
    assert.equal(validateLessonContract('help-record', { ...base, timestamp }).ok, true, timestamp);
  }
  const bad = ['2026-11-01', '2026-11-01 09:30:00Z', '2026-11-01T09:30:00', '2026-02-30T09:30:00Z',
    '2027-02-29T09:30:00Z', '2026-13-01T09:30:00Z', '2026-11-01T24:00:00Z', '2026-11-01T09:60:00Z', '2026-11-01T10:00:60Z', '2026-12-31T23:59:60Z',
    '2026-11-01T09:30:00+25:00', 'yesterday', '', 1793000000, null];
  for (const timestamp of bad) {
    assert.equal(validateLessonContract('help-record', { ...base, timestamp }).ok, false, String(timestamp));
  }
});

test('module ids follow the documented identifier pattern', async () => {
  const minimal = await load('valid/lesson-module-minimal.json');
  for (const id of ['a', 'intro-1', '0start', 'x'.repeat(60)]) {
    assert.equal(validateLessonContract('lesson-module', { ...minimal, id }).ok, true, id);
  }
  for (const id of ['', 'Upper', '-lead', 'has space', 'under_score', 'x'.repeat(61), 'dot.id', '日本語', 'a/b', 7]) {
    assert.equal(validateLessonContract('lesson-module', { ...minimal, id }).ok, false, String(id));
  }
});

test('text with special characters survives validation unchanged', async () => {
  const minimal = await load('valid/lesson-module-minimal.json');
  const text = 'Use "quotes", O\'Brien, 日本語, emoji \u{1F600}, and SQL: \'; DROP TABLE x; --';
  const next = structuredClone(minimal);
  next.blocks[0].body = text;
  next.title = text;
  const result = validateLessonContract('lesson-module', next);
  assert.deepEqual(result, { ok: true });
  assert.equal(next.blocks[0].body, text);
});

test('a large packet validates in reasonable time', async () => {
  const packet = await load('valid/packet-multi-module.json');
  const big = structuredClone(packet);
  big.modules = Array.from({ length: 1000 }, (_, index) => ({ id: `module-${index}`, version: '1.0.0' }));
  const start = performance.now();
  const result = validateLessonContract('packet', big);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(performance.now() - start < 2000);
  big.modules.push({ id: 'module-1', version: '1.0.0' });
  assert.equal(validateLessonContract('packet', big).ok, false);
});

// A source this repository cannot vouch for is replaced by a neutral example link in the fixtures.
const replacedUrls = { 'https://arxiv.org/abs/2608.02412': 'https://example.org/sources/paper2026' };

test('the soccer packet fixture follows the structure of the shipped curriculum', async () => {
  const curriculum = await readJSON(new URL('curriculum.json', root));
  const packet = await load('valid/packet-soccer-ml.json');
  assert.equal(packet.modules.length, curriculum.modules.length);
  const prefix = `${curriculum.id}-`;
  for (const [index, reference] of packet.modules.entries()) {
    const source = curriculum.modules[index];
    assert.equal(reference.id, `${prefix}${source.id}`);
    const entry = manifest.find((item) => item.kind === 'lesson-module' && item.name === `lesson-module-soccer-${source.id}`);
    assert.ok(entry, `manifest entry for ${source.id}`);
    assert.equal(entry.expect, 'valid');
    const module = await load(entry.file);
    assert.equal(module.id, reference.id);
    assert.equal(module.version, reference.version);
    assert.equal(module.title, source.title);
    assert.equal(module.outcome, source.outcome);
    assert.deepEqual(module.tasks.map((task) => task.prompt), source.tasks);
    assert.deepEqual(module.prerequisites, source.prerequisites.map((id) => `${prefix}${id}`));
    assert.equal(module.estimatedMinutes, source.hours * 60);
    const links = module.blocks.filter((block) => block.type === 'source-link');
    const expectedUrl = (key) => {
      const url = curriculum.resources[key].url;
      return Object.hasOwn(replacedUrls, url) ? replacedUrls[url] : url;
    };
    assert.deepEqual(links.map((block) => block.url), source.resources.map(expectedUrl));
  }
});

test('no fixture links to a source that the maintainers have not verified', async () => {
  const unverified = ['2608.02412', 'arxiv.org'];
  for (const entry of manifest) {
    const text = await readText(fixture(entry.file));
    for (const marker of unverified) assert.equal(text.includes(marker), false, `${entry.file} mentions ${marker}`);
  }
});

const tempFolder = async () => mkdtemp(path.join(tmpdir(), 'schola-lesson-'));

test('text over the size limit is refused before it is parsed', async () => {
  assert.equal(MAX_BYTES, 5 * 1024 * 1024);
  const over = `"${'a'.repeat(MAX_BYTES)}"`;
  const result = validateLessonText('packet', over);
  assert.deepEqual(result, { ok: false, reason: 'too_large', errors: [{ pointer: '', message: 'The document is larger than the 5 MB limit.' }] });
  // The limit counts bytes, not characters: a multi-byte character costs more than one.
  const wide = '\u00E9'.repeat(Math.floor(MAX_BYTES / 2) + 1);
  assert.equal(wide.length < MAX_BYTES, true);
  assert.equal(validateLessonText('packet', wide).reason, 'too_large');
  const edge = `"${' '.repeat(MAX_BYTES - 2)}"`;
  assert.equal(Buffer.byteLength(edge), MAX_BYTES);
  assert.equal(validateLessonText('packet', edge).reason, 'invalid', 'exactly at the limit is parsed');
  assert.equal(validateLessonText('packet', 5).reason, 'invalid');
});

test('a file over the size limit is refused without being read or changed', async (t) => {
  const folder = await tempFolder();
  try {
    const target = path.join(folder, 'huge.json');
    const handle = await open(target, 'w');
    await handle.truncate(MAX_BYTES + 1);
    await handle.close();
    await chmod(target, 0o000);
    if (process.getuid?.() === 0) t.diagnostic('running as root: the unreadable-file proof is weaker');
    const old = new Date('2020-01-02T03:04:05Z');
    await utimes(target, old, old);
    const before = await stat(target);
    const result = await validateLessonFile('lesson-module', target);
    assert.deepEqual(result, { ok: false, reason: 'too_large', errors: [{ pointer: '', message: 'The document is larger than the 5 MB limit.' }] });
    const after = await stat(target);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, MAX_BYTES + 1);
    assert.deepEqual(await readdir(folder), ['huge.json']);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('an unreadable file reports the error code and never an absolute path', async () => {
  const folder = await tempFolder();
  try {
    const missing = await validateLessonFile('lesson-module', path.join(folder, 'missing.json'));
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'unreadable');
    assert.match(missing.errors[0].message, /ENOENT/);
    await mkdir(path.join(folder, 'adir'));
    const directory = await validateLessonFile('lesson-module', path.join(folder, 'adir'));
    assert.equal(directory.reason, 'unreadable');
    assert.match(directory.errors[0].message, /EISDIR/);
    for (const result of [missing, directory]) {
      assert.equal(result.errors[0].pointer, '');
      assert.equal(result.errors[0].message.includes(folder), false);
      assert.equal(result.errors[0].message.includes(path.sep + 'tmp'), false);
    }
    const locked = path.join(folder, 'locked.json');
    await writeFile(locked, '{}');
    await chmod(locked, 0o000);
    if (process.getuid?.() !== 0) {
      const denied = await validateLessonFile('lesson-module', locked);
      assert.equal(denied.reason, 'unreadable');
      assert.match(denied.errors[0].message, /EACCES/);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a long list of errors is cut at 100 and says how many were left out', async () => {
  const packet = await load('valid/packet-multi-module.json');
  const many = structuredClone(packet);
  many.modules = Array.from({ length: 150 }, (_, index) => ({ id: `module-${index}` }));
  const result = validateLessonContract('packet', many);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 101);
  assert.match(result.errors[100].message, /^\d+ more errors omitted\.$/);
  assert.equal(result.errors[100].pointer, '');
  const omitted = Number(/^(\d+)/.exec(result.errors[100].message)[1]);
  assert.equal(omitted, 150 - 100);
  const few = structuredClone(packet);
  few.modules = [{ id: 'module-0' }];
  assert.equal(validateLessonContract('packet', few).errors.some((error) => /omitted/.test(error.message)), false);
});
