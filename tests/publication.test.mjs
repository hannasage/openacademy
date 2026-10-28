import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectPublication } from '../web/publication.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/valid/legacy-backup.json', import.meta.url), 'utf8'));

test('publication keeps supported content and returns a fresh version 1 backup', () => {
  const local = fixture();
  const published = projectPublication(local);
  assert.deepEqual(published, local);
  published.state.modules.baseline.notes = 'Changed remotely';
  assert.notEqual(published.state.modules.baseline.notes, local.state.modules.baseline.notes);
});

test('publication strips private extension fields at every object level', () => {
  const local = fixture();
  local.draft = { experiment: { title: 'Private' } };
  local.curriculum.draft = 'Private';
  local.curriculum.resources.guide.password = 'Private';
  local.curriculum.modules[0].draft = 'Private';
  local.state.selectedModule = 'Private';
  local.state.modules.baseline.accessToken = 'Private';
  local.state.experiments.push({ id: 'e1', date: '', module: 'baseline', title: 'Result', hypothesis: '', result: '', secret: 'Private' });
  const published = projectPublication(local);
  assert.equal(JSON.stringify(published).includes('Private'), false);
  assert.equal(local.curriculum.draft, 'Private');
  assert.equal(published.state.experiments[0].title, 'Result');
});

test('unsupported or missing core fields fail before publishing', () => {
  const changes = [
    (b) => { b.curriculum.version = 2; },
    (b) => { b.state.version = 2; },
    (b) => { delete b.curriculum.modules[0].tasks; },
    (b) => { b.curriculum.resources.guide.url = 'javascript:alert(1)'; },
    (b) => { b.state.revision = 0.5; },
    (b) => { b.state.modules.baseline.tasks = ['yes', false]; },
    (b) => { b.state.modules.baseline.hours = NaN; },
    (b) => { b.state.experiments = null; },
  ];
  for (const change of changes) {
    const local = fixture();
    change(local);
    assert.throws(() => projectPublication(local), TypeError);
  }
});

test('publication rejects broken references and unsupported completion claims', () => {
  const changes = [
    (b) => { b.state.curriculumId = 'different'; },
    (b) => { b.curriculum.modules.push(structuredClone(b.curriculum.modules[0])); },
    (b) => { b.curriculum.modules[0].resources = ['missing']; },
    (b) => { b.curriculum.modules[0].prerequisites = ['missing']; },
    (b) => { b.curriculum.modules[0].weekEnd = 2; },
    (b) => { b.state.modules.missing = b.state.modules.baseline; },
    (b) => { b.state.modules.baseline.tasks = [true]; },
    (b) => { b.state.modules.baseline.status = 'complete'; },
    (b) => { b.state.startDate = '2026-02-30'; },
  ];
  for (const change of changes) {
    const local = fixture();
    change(local);
    assert.throws(() => projectPublication(local), TypeError);
  }
});

test('unsupported backup format is rejected; an unmarked legacy backup is accepted', () => {
  const local = fixture();
  local.format = 'different';
  assert.throws(() => projectPublication(local), TypeError);
  delete local.format;
  assert.equal(projectPublication(local).format, 'touchline-backup');
});

test('legacy optional metadata stays local when it cannot meet the public contract', () => {
  const local = fixture();
  local.curriculum.totalHours = { legacyEstimate: 'unverified' };
  assert.throws(() => projectPublication(local), /curriculum.totalHours/);
  delete local.curriculum.totalHours;
  local.curriculum.modules[0].number = 'First';
  assert.throws(() => projectPublication(local), /modules\[0\].number/);
  assert.equal(local.curriculum.modules[0].number, 'First');
});
