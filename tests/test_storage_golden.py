"""Golden data for the storage layout that existed before the S03 changes.

The fixture under tests/fixtures/storage/pre-s03 is a frozen copy of three data
directories. The current build wrote the record layout and the recovery layout
through its real HTTP API. The legacy layout follows the file formats of the
first builds. These tests prove three things:

1. Every fixture file matches its SHA-256 digest in the manifest.
2. The current code reads each layout, leaves every byte unchanged on reads, and
   writes the same bytes again when it saves.
3. The current code still builds the same bytes from scratch.

Never rebuild the fixture to make a test pass. A failure here means a change
broke an older data directory. Run this file with --write only to create the
fixture again on purpose.
"""
import copy
import hashlib
import json
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import HTTPServer
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from local_store import LocalStore
from server import Handler, initial, validate, validate_curriculum

FIXTURE = ROOT / 'tests' / 'fixtures' / 'storage' / 'pre-s03'
MANIFEST = FIXTURE / 'manifest.json'
LAYOUTS = ('current-layout', 'legacy-layout', 'recovery-layout')

SOCCER_RECORD_ID = 'ac02873e-ad82-58bc-8266-b1e4abb684f4'
SAMPLE_RECORD_ID = '102ae896-9acf-51ed-b1a0-58a6fba0b9f0'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def tree_digests(directory):
    directory = Path(directory)
    return {str(p.relative_to(directory)): sha256(p.read_bytes())
            for p in sorted(directory.rglob('*')) if p.is_file()}


def dump(value):
    """The exact bytes the current build writes for a record or library file."""
    return (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()


def built_in_course():
    return json.loads((ROOT / 'curriculum.json').read_text())


# --- Building the fixture from the real code ---------------------------------

@contextmanager
def live_server(directory):
    server = HTTPServer(('127.0.0.1', 0), Handler)
    server.data_dir = Path(directory)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def call(method, path, body=None):
        connection = HTTPConnection('127.0.0.1', server.server_port)
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    try:
        yield call
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def build_current(target):
    """One soccer record: progress, an experiment, a draft, a selected lesson, a backup, a focus."""
    course = built_in_course()
    tasks = {m['id']: len(m['tasks']) for m in course['modules']}
    with live_server(target) as call:
        status, record = call('GET', '/api/record?plan=soccer-ml')
        assert status == 200, record
        route = '/api/records/' + record['recordId']
        first = copy.deepcopy(record)
        first['state'].update(weeklyHours=8, startDate='2026-01-05')
        first['state']['modules']['m01'] = {
            'status': 'active', 'tasks': [True, True] + [False] * (tasks['m01'] - 2),
            'notes': 'Synthetic note: split the matches by date before any model.',
            'evidence': '', 'hours': 3}
        status, saved = call('PUT', route, {'expectedRevision': 0, 'record': first})
        assert status == 200, saved
        final = copy.deepcopy(saved)
        final['state']['modules']['m01'] = {
            'status': 'complete', 'tasks': [True] * tasks['m01'],
            'notes': 'Synthetic note: split the matches by date before any model.',
            'evidence': 'Synthetic evidence: the baseline scored worse on the untouched test set.',
            'hours': 6.5}
        final['state']['modules']['m02'] = {
            'status': 'active', 'tasks': [True] + [False] * (tasks['m02'] - 1),
            'notes': 'Synthetic note: count missing rows first.', 'evidence': '', 'hours': 1.5}
        final['state']['experiments'] = [{
            'id': 'experiment-1', 'date': '2026-01-12', 'module': 'm01',
            'title': 'Synthetic baseline run',
            'hypothesis': 'Home wins are the most common result.',
            'result': 'Home wins were the most common result in the training set.'}]
        final['view']['selectedModuleId'] = 'm02'
        final['draft']['experiment'] = {
            'id': None, 'date': '', 'module': 'm02', 'title': '',
            'hypothesis': 'Synthetic draft: does recent form beat the frequency baseline?',
            'result': ''}
        status, saved = call('PUT', route, {'expectedRevision': 1, 'record': final})
        assert status == 200, saved
        status, library = call('GET', '/api/library')
        status, saved = call('PUT', '/api/library', {'expectedRevision': library['revision'],
                                                     'focusRecordId': record['recordId']})
        assert status == 200, saved


def write_legacy_file(path, value, newline):
    """First builds wrote json.dump(value, indent=2) with no final newline."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + ('\n' if newline else ''))


def build_legacy(target):
    """Originals as the first builds wrote them: state.json, state.backup.json, curricula/*.json."""
    target = Path(target)
    course = built_in_course()
    soccer = initial(course)
    soccer['weeklyHours'] = 6
    soccer['modules']['m01'] = {
        'status': 'active', 'tasks': [True] + [False] * (len(course['modules'][0]['tasks']) - 1),
        'notes': 'Synthetic note: legacy progress.', 'evidence': '', 'hours': 2}
    previous = copy.deepcopy(soccer)
    soccer['revision'] = 2
    previous['revision'] = 1
    previous['modules']['m01']['hours'] = 1
    write_legacy_file(target / 'soccer-ml' / 'state.json', soccer, False)
    write_legacy_file(target / 'soccer-ml' / 'state.backup.json', previous, False)

    sample = copy.deepcopy(course)
    sample.update(id='legacy-sample', title='Synthetic legacy sample',
                  subtitle='Two lessons kept from an imported plan',
                  description='Synthetic curriculum used to test files from the first builds.')
    sample['modules'] = sample['modules'][:2]
    sample['totalHours'] = sum(m['hours'] for m in sample['modules'])
    write_legacy_file(target / 'curricula' / 'legacy-sample.json', sample, False)
    state = initial(sample)
    state['revision'] = 4
    state['modules']['m02'] = {
        'status': 'active', 'tasks': [False] * len(sample['modules'][1]['tasks']),
        'notes': 'Synthetic note: imported plan.', 'evidence': '', 'hours': 0.5}
    write_legacy_file(target / 'legacy-sample' / 'state.json', state, False)


def build_recovery(target, current):
    """Damage the record, then recover it from its backup through the real API."""
    shutil.copytree(current, target)
    record_path = Path(target) / 'records' / SOCCER_RECORD_ID / 'record.json'
    record_path.write_bytes(record_path.read_bytes()[:200])
    with live_server(target) as call:
        status, options = call('GET', '/api/recovery')
        assert status == 200 and len(options) == 1, options
        status, restored = call('POST', '/api/recovery', {
            'recordId': options[0]['recordId'], 'damagedDigest': options[0]['damagedDigest']})
        assert status == 200, restored


def write_fixture():
    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    build_current(FIXTURE / 'current-layout')
    build_legacy(FIXTURE / 'legacy-layout')
    build_recovery(FIXTURE / 'recovery-layout', FIXTURE / 'current-layout')
    files = {}
    for layout in LAYOUTS:
        for name, digest in tree_digests(FIXTURE / layout).items():
            files[layout + '/' + name] = digest
    manifest = {'version': 1, 'algorithm': 'sha256',
                'builtInCurriculumSha256': sha256((ROOT / 'curriculum.json').read_bytes()),
                'files': files}
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')


# --- Tests -------------------------------------------------------------------

def load_manifest():
    return json.loads(MANIFEST.read_text())


class WorkingCopy(unittest.TestCase):
    """Copy one frozen layout to a temporary folder, so a test never edits the fixture."""
    layout = 'current-layout'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'work'
        shutil.copytree(FIXTURE / self.layout, self.directory)
        self.before = tree_digests(self.directory)
        self.course = self.frozen_course()
        self.store = LocalStore(self.directory, self.course, validate_curriculum, validate, initial)

    def frozen_course(self):
        """Use the curriculum frozen inside the fixture, so a later edit to curriculum.json does not change this baseline."""
        for path in sorted((FIXTURE / 'current-layout' / 'records').glob('*/record.json')):
            return json.loads(path.read_text())['curriculum']
        raise AssertionError('Golden record is missing.')

    def assertTreeUnchanged(self):
        self.assertEqual(tree_digests(self.directory), self.before)


class ManifestTests(unittest.TestCase):
    def test_manifest_lists_every_fixture_file_and_nothing_else(self):
        listed = set(load_manifest()['files'])
        present = {name for name in tree_digests(FIXTURE) if name != 'manifest.json'}
        self.assertEqual(listed, present)

    def test_every_fixture_file_matches_its_digest(self):
        manifest = load_manifest()
        self.assertEqual((manifest['version'], manifest['algorithm']), (1, 'sha256'))
        actual = tree_digests(FIXTURE)
        for name, digest in manifest['files'].items():
            with self.subTest(file=name):
                self.assertRegex(digest, r'^[0-9a-f]{64}$')
                self.assertEqual(actual[name], digest)

    def test_fixture_holds_the_files_the_inventory_describes(self):
        files = set(load_manifest()['files'])
        record = f'current-layout/records/{SOCCER_RECORD_ID}/'
        self.assertLessEqual({'current-layout/library.json', record + 'record.json', record + 'record.backup.json',
                              'legacy-layout/soccer-ml/state.json', 'legacy-layout/soccer-ml/state.backup.json',
                              'legacy-layout/curricula/legacy-sample.json', 'legacy-layout/legacy-sample/state.json',
                              f'recovery-layout/records/{SOCCER_RECORD_ID}/recovery-state.json'}, files)
        self.assertEqual(len([f for f in files if '/record.damaged-' in f]), 1)

    def test_fixture_holds_no_personal_data_or_secrets(self):
        text = ''.join(p.read_text() for p in FIXTURE.rglob('*') if p.is_file()).lower()
        for marker in ('/users/', '@', 'password', 'secret', 'token'):
            with self.subTest(marker=marker):
                self.assertNotIn(marker, text)


class CurrentLayoutTests(WorkingCopy):
    def test_known_record_is_read_and_reads_change_no_byte(self):
        record = self.store.local_record('soccer-ml')
        self.assertEqual(record['recordId'], SOCCER_RECORD_ID)
        self.assertEqual((record['format'], record['version'], record['origin'], record['status']),
                         ('touchline-record', 2, {'kind': 'local'}, 'active'))
        self.assertEqual(record['state']['revision'], 2)
        self.assertEqual((record['state']['weeklyHours'], record['state']['startDate']), (8, '2026-01-05'))
        self.assertEqual(record['state']['modules']['m01']['status'], 'complete')
        self.assertEqual(record['state']['modules']['m02']['tasks'][:2], [True, False])
        self.assertEqual(len(record['state']['experiments']), 1)
        self.assertEqual(record['view'], {'selectedModuleId': 'm02'})
        self.assertEqual(record['draft']['experiment']['module'], 'm02')
        self.assertEqual(self.store.get_record(SOCCER_RECORD_ID), record)
        library = self.store.library()
        self.assertEqual((library['version'], library['revision'], library['focusRecordId']), (1, 1, SOCCER_RECORD_ID))
        self.assertEqual([r['recordId'] for r in library['records']], [SOCCER_RECORD_ID])
        self.assertEqual(self.store.recovery_options(), [])
        self.assertTreeUnchanged()

    def test_backup_is_the_previous_save(self):
        backup = json.loads((self.directory / 'records' / SOCCER_RECORD_ID / 'record.backup.json').read_text())
        self.assertEqual(backup['state']['revision'], 1)
        self.assertEqual(backup['state']['modules']['m01']['status'], 'active')
        self.assertEqual(backup['recordId'], SOCCER_RECORD_ID)

    def test_records_reserialize_to_the_same_bytes(self):
        record = self.store.local_record('soccer-ml')
        folder = self.directory / 'records' / SOCCER_RECORD_ID
        self.assertEqual(dump(record), (folder / 'record.json').read_bytes())
        backup = json.loads((folder / 'record.backup.json').read_text())
        self.assertEqual(dump(backup), (folder / 'record.backup.json').read_bytes())
        library = json.loads((self.directory / 'library.json').read_text())
        self.assertEqual(dump(library), (self.directory / 'library.json').read_bytes())
        self.assertEqual(library, {'version': 1, 'revision': 1, 'focusRecordId': SOCCER_RECORD_ID})

    def test_saving_unchanged_content_keeps_content_and_backs_up_the_old_bytes(self):
        folder = self.directory / 'records' / SOCCER_RECORD_ID
        original = (folder / 'record.json').read_bytes()
        record = self.store.local_record('soccer-ml')
        saved = self.store.save_record(SOCCER_RECORD_ID, 2, record)
        self.assertEqual(saved['state']['revision'], 3)
        self.assertEqual((folder / 'record.backup.json').read_bytes(), original)
        expected = copy.deepcopy(record)
        expected['state']['revision'] = 3
        self.assertEqual((folder / 'record.json').read_bytes(), dump(expected))

    def test_real_server_reads_leave_the_tree_unchanged(self):
        with live_server(self.directory) as call:
            status, record = call('GET', '/api/record?plan=soccer-ml')
            self.assertEqual((status, record['recordId']), (200, SOCCER_RECORD_ID))
            self.assertEqual(call('GET', '/api/state?plan=soccer-ml'), (200, record['state']))
            self.assertEqual(call('GET', f'/api/records/{SOCCER_RECORD_ID}/export'), (200, record))
            status, library = call('GET', '/api/library')
            self.assertEqual((status, library['focusRecordId']), (200, SOCCER_RECORD_ID))
            self.assertEqual(call('GET', '/api/recovery'), (200, []))
            status, courses = call('GET', '/api/curricula')
            self.assertEqual((status, [c['id'] for c in courses]), (200, ['soccer-ml']))
        self.assertTreeUnchanged()


class LegacyLayoutTests(WorkingCopy):
    layout = 'legacy-layout'

    def originals(self):
        return {name: digest for name, digest in tree_digests(self.directory).items() if not name.startswith('records/')}

    def test_reading_migrates_into_records_and_never_edits_an_original(self):
        original_digests = self.originals()
        soccer = self.store.local_record('soccer-ml')
        sample = self.store.local_record('legacy-sample')
        self.assertEqual((soccer['recordId'], sample['recordId']), (SOCCER_RECORD_ID, SAMPLE_RECORD_ID))
        self.assertEqual(soccer['state'], json.loads((self.directory / 'soccer-ml' / 'state.json').read_text()))
        self.assertEqual(sample['state'], json.loads((self.directory / 'legacy-sample' / 'state.json').read_text()))
        self.assertEqual((soccer['state']['revision'], sample['state']['revision']), (2, 4))
        self.assertEqual([m['id'] for m in sample['curriculum']['modules']], ['m01', 'm02'])
        self.assertEqual((soccer['status'], soccer['view'], soccer['draft']),
                         ('active', {'selectedModuleId': 'm01'}, {'experiment': None}))
        self.assertEqual(self.originals(), original_digests)
        added = set(tree_digests(self.directory)) - set(self.before)
        self.assertEqual(added, {f'records/{SOCCER_RECORD_ID}/record.json', f'records/{SAMPLE_RECORD_ID}/record.json'})

    def test_second_read_is_a_no_op(self):
        self.store.library()
        migrated = tree_digests(self.directory)
        self.assertEqual(self.store.library()['records'], LocalStore(
            self.directory, self.course, validate_curriculum, validate, initial).library()['records'])
        self.assertEqual(tree_digests(self.directory), migrated)

    def test_saving_a_migrated_record_leaves_originals_unchanged(self):
        original_digests = self.originals()
        record = self.store.local_record('soccer-ml')
        self.store.save_record(record['recordId'], 2, record)
        self.assertEqual(self.originals(), original_digests)

    def test_library_lists_both_records_in_folder_order(self):
        records = self.store.library()['records']
        self.assertEqual(sorted(r['curriculumId'] for r in records), ['legacy-sample', 'soccer-ml'])


class RecoveryLayoutTests(WorkingCopy):
    layout = 'recovery-layout'

    def test_recovered_record_reads_and_keeps_every_recovery_file(self):
        folder = self.directory / 'records' / SOCCER_RECORD_ID
        record = self.store.local_record('soccer-ml')
        self.assertEqual(record['state']['revision'], 3)
        self.assertEqual(record['state']['modules']['m01']['status'], 'active')
        self.assertEqual(json.loads((folder / 'recovery-state.json').read_text()), {'version': 1, 'revision': 3})
        damaged = list(folder.glob('record.damaged-*.json'))
        self.assertEqual(len(damaged), 1)
        self.assertEqual(len(damaged[0].read_bytes()), 200)
        self.assertEqual(self.store.recovery_options(), [])
        self.assertEqual(dump(record), (folder / 'record.json').read_bytes())
        self.assertTreeUnchanged()

    def test_damaged_file_name_carries_the_review_digest(self):
        folder = self.directory / 'records' / SOCCER_RECORD_ID
        damaged = next(folder.glob('record.damaged-*.json'))
        backup = json.loads((folder / 'record.backup.json').read_text())
        digest = LocalStore._recovery_digest(backup, damaged.read_bytes(), 0)
        self.assertEqual(damaged.name, f'record.damaged-{digest}.json')


class RebuildTests(unittest.TestCase):
    def test_current_code_builds_the_same_bytes_from_scratch(self):
        manifest = load_manifest()
        if sha256((ROOT / 'curriculum.json').read_bytes()) != manifest['builtInCurriculumSha256']:
            self.skipTest('The built-in curriculum changed after the fixture was frozen.')
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            build_current(temp / 'current-layout')
            build_legacy(temp / 'legacy-layout')
            build_recovery(temp / 'recovery-layout', temp / 'current-layout')
            for name, digest in tree_digests(temp).items():
                with self.subTest(file=name):
                    self.assertEqual(manifest['files'].get(name), digest)
            self.assertEqual(set(tree_digests(temp)), set(manifest['files']))


if __name__ == '__main__':
    if sys.argv[1:] == ['--write']:
        write_fixture()
    else:
        unittest.main()
