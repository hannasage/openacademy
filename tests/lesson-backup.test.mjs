import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = new URL('../', import.meta.url);
const readJSON = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const name of (await readdir(new URL('contracts/', root))).filter((file) => file.endsWith('.schema.json'))) {
  ajv.addSchema(await readJSON(`contracts/${name}`));
}
const validate = ajv.getSchema('urn:schola:contract:lesson-backup:v1');
const manifest = await readJSON('tests/fixtures/contracts/lesson-backup-conformance.json');

test('the lesson backup schema is registered', () => {
  assert.ok(validate);
});

for (const entry of manifest) {
  test(`lesson backup schema: ${entry.name}`, async () => {
    const value = await readJSON(`tests/fixtures/contracts/lesson-backup/${entry.file}`);
    // Only the schema stage is a schema failure. Later stages pass the schema and fail a semantic rule,
    // which the Python restore checks. A version failure is read before the schema, so it is not run here.
    const schemaFails = entry.stage === 'schema';
    if (entry.stage === 'version') return;
    assert.equal(validate(value), !schemaFails, JSON.stringify(validate.errors));
  });
}

test('every backup fixture is listed once in the manifest', async () => {
  const onDisk = [];
  for (const folder of ['valid', 'invalid']) {
    for (const name of await readdir(new URL(`tests/fixtures/contracts/lesson-backup/${folder}/`, root))) onDisk.push(`${folder}/${name}`);
  }
  assert.deepEqual(onDisk.sort(), manifest.map((entry) => entry.file).sort());
});
