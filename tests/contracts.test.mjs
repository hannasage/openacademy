import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { projectPublication } from '../web/publication.js';

const root = new URL('../', import.meta.url);
const readJSON = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaFiles = (await readdir(new URL('contracts/', root))).filter((name) => name.endsWith('.schema.json'));
for (const name of schemaFiles) ajv.addSchema(await readJSON(`contracts/${name}`));
const cases = await readJSON('tests/fixtures/contracts/cases.json');
for (const entry of cases) {
  test(`contract: ${entry.name}`, async () => {
    const schema = await readJSON(`contracts/${entry.schema}`);
    const validate = ajv.getSchema(schema.$id);
    assert.ok(validate);
    const value = await readJSON(`tests/fixtures/contracts/${entry.file}`);
    assert.equal(validate(value), entry.valid, JSON.stringify(validate.errors));
    if (entry.valid) {
      const decoded = JSON.parse(JSON.stringify(value));
      assert.deepEqual(decoded, value);
      assert.equal(validate(decoded), true);
    }
  });
}

test('the shipped curriculum remains a valid version 1 curriculum', async () => {
  const schema = await readJSON('contracts/curriculum.v1.schema.json');
  const validate = ajv.getSchema(schema.$id);
  assert.equal(validate(await readJSON('curriculum.json')), true, JSON.stringify(validate.errors));
});

test('publication never accepts local record state, drafts, navigation, or bindings', async () => {
  const snapshot = await readJSON('tests/fixtures/contracts/valid/published-course.json');
  const schema = await readJSON('contracts/published-course.v1.schema.json');
  const validate = ajv.getSchema(schema.$id);
  for (const key of ['draft', 'view', 'recordId', 'origin', 'binding', 'state']) {
    assert.equal(validate({ ...snapshot, [key]: {} }), false, key);
  }
  const nested = structuredClone(snapshot);
  nested.progress.draft = { experiment: {} };
  assert.equal(validate(nested), false);
});

test('hub discovery rejects every private credential or account field at every object level', async () => {
  const hub = await readJSON('tests/fixtures/contracts/valid/hub-description.json');
  const schema = await readJSON('contracts/hub-description.v1.schema.json');
  const validate = ajv.getSchema(schema.$id);
  for (const field of ['serviceRoleKey', 'secretKey', 'accessToken', 'refreshToken', 'managementToken', 'ownerEmail', 'password']) {
    for (const target of [null, 'backend', 'auth', 'contracts']) {
      const altered = structuredClone(hub);
      (target ? altered[target] : altered)[field] = 'must-not-travel';
      assert.equal(validate(altered), false, `${target ?? 'root'}.${field}`);
    }
  }
});

test('unknown versions fail every versioned contract', async () => {
  for (const entry of cases.filter((entry) => entry.valid && entry.semanticValid !== false)) {
    const value = await readJSON(`tests/fixtures/contracts/${entry.file}`);
    if (!Object.hasOwn(value, 'version')) continue;
    const schema = await readJSON(`contracts/${entry.schema}`);
    assert.equal(ajv.getSchema(schema.$id)({ ...value, version: 999 }), false, entry.name);
  }
});


test('publication projection conforms to the closed public schemas', async () => {
  const record = await readJSON('tests/fixtures/contracts/valid/legacy-extensions.json');
  const backup = projectPublication({ curriculum: record.curriculum, state: record.state });
  for (const [field, schemaName] of [['curriculum', 'public-curriculum.v1'], ['state', 'public-progress.v1']]) {
    const validate = ajv.getSchema(`urn:touchline:contract:${schemaName}`);
    assert.equal(validate(backup[field]), true, JSON.stringify(validate.errors));
  }
  assert.ok(record.curriculum.extension);
  assert.equal(Object.hasOwn(backup.curriculum, 'extension'), false);
  assert.equal(Object.hasOwn(backup.state, 'extension'), false);
});
