import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from server import initial, validate, validate_curriculum
from local_store import LocalStore, StoreError

ROOT = Path(__file__).resolve().parents[1]


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.course = json.loads((ROOT / 'curriculum.json').read_text())
        self.store = self.new_store()

    def new_store(self):
        return LocalStore(self.directory, self.course, validate_curriculum, validate, initial)

    def local(self):
        return self.store.local_record(self.course['id'])

    def cloud(self, account=None, backend='https://one.supabase.co'):
        return {'kind': 'cloud', 'hubId': 'adcd44aa-85da-4548-84bc-1ada69c19099',
                'backendOrigin': backend, 'accountId': account or str(uuid4())}

    def backup(self):
        return {'curriculum': copy.deepcopy(self.course), 'state': initial(self.course)}

    def test_legacy_migration_is_repeat_safe_and_preserves_original(self):
        path = self.directory / self.course['id'] / 'state.json'
        path.parent.mkdir()
        state = initial(self.course)
        state['weeklyHours'] = 5
        path.write_text(json.dumps(state))
        original = path.read_bytes()
        record = self.local()
        self.assertEqual(record['state']['weeklyHours'], 5)
        self.assertEqual(self.new_store().local_record(self.course['id'])['recordId'], record['recordId'])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(list((self.directory / 'records').glob('*/record.json'))), 1)

    def test_draft_and_selected_lesson_survive_restart(self):
        record = self.local()
        record['view']['selectedModuleId'] = self.course['modules'][1]['id']
        record['draft']['experiment'] = {'id': None, 'date': '', 'module': self.course['modules'][0]['id'],
                                         'title': '', 'hypothesis': 'A question before a run', 'result': ''}
        saved = self.store.save_record(record['recordId'], 0, record)
        restored = self.new_store().get_record(saved['recordId'])
        self.assertEqual(restored['draft'], record['draft'])
        self.assertEqual(restored['view'], record['view'])
        self.assertEqual(restored['state']['revision'], 1)

    def test_same_curriculum_is_isolated_by_hub_and_account(self):
        first, second = self.cloud(), self.cloud()
        third = dict(first, backendOrigin='https://two.supabase.co')
        records = [self.store.import_record(self.backup(), origin, 'active') for origin in [first, second, third]]
        self.assertEqual(len({r['recordId'] for r in records}), 3)
        self.assertEqual(len(self.store.library()['records']), 1)
        self.assertEqual({r['recordId'] for r in self.store.library(first)['records']}, {self.local()['recordId'], records[0]['recordId']})
        with self.assertRaises(StoreError) as denied:
            self.store.get_record(records[0]['recordId'], second)
        self.assertEqual(denied.exception.status, 404)

    def test_duplicate_origin_is_rejected(self):
        origin = self.cloud()
        self.store.import_record(self.backup(), origin, 'active')
        with self.assertRaises(StoreError) as duplicate:
            self.store.import_record(self.backup(), origin, 'saved')
        self.assertEqual(duplicate.exception.status, 409)

    def test_stale_record_and_library_writes_are_rejected(self):
        record = self.local()
        saved = self.store.save_record(record['recordId'], 0, record)
        with self.assertRaises(StoreError) as stale:
            self.store.save_record(record['recordId'], 0, record)
        self.assertEqual(stale.exception.status, 409)
        self.assertEqual(self.store.get_record(record['recordId']), saved)
        self.store.save_library(0, record['recordId'])
        with self.assertRaises(StoreError):
            self.store.save_library(0, None)

    def test_focus_does_not_follow_selection_or_reappear_after_pause(self):
        record = self.local()
        self.store.save_library(0, record['recordId'])
        record['view']['selectedModuleId'] = self.course['modules'][1]['id']
        saved = self.store.save_record(record['recordId'], 0, record)
        self.assertEqual(self.store.library()['focusRecordId'], record['recordId'])
        saved['status'] = 'paused'
        saved = self.store.save_record(record['recordId'], saved['state']['revision'], saved)
        self.assertIsNone(self.store.library()['focusRecordId'])
        saved['status'] = 'active'
        self.store.save_record(record['recordId'], saved['state']['revision'], saved)
        self.assertIsNone(self.store.library()['focusRecordId'])

    def test_identity_and_record_id_cannot_change(self):
        record = self.local()
        for change in [{'origin': self.cloud()}, {'recordId': str(uuid4())}]:
            with self.subTest(change=change):
                changed = dict(record, **change)
                with self.assertRaises(StoreError):
                    self.store.save_record(record['recordId'], 0, changed)
        self.assertEqual(self.local(), record)

    def test_atomic_replacement_failure_preserves_record_and_backup(self):
        record = self.local()
        target = self.directory / 'records' / record['recordId'] / 'record.json'
        original = target.read_bytes()
        record['state']['weeklyHours'] = 8
        real_replace = Path.replace
        def failing_replace(path, destination):
            if Path(destination) == target:
                raise OSError('simulated full disk')
            return real_replace(path, destination)
        with patch.object(Path, 'replace', failing_replace):
            with self.assertRaises(OSError):
                self.store.save_record(record['recordId'], 0, record)
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(target.with_name('record.backup.json').read_bytes(), original)

    def test_replacement_import_is_atomic_and_retains_previous(self):
        record = self.local()
        backup = self.backup()
        backup['curriculum']['title'] = 'Revised title'
        backup['state']['weeklyHours'] = 6
        restored = self.store.import_record(backup, {'kind': 'local'}, 'active', record['recordId'], 0)
        self.assertEqual(restored['curriculum']['title'], 'Revised title')
        self.assertEqual(restored['state']['weeklyHours'], 6)
        prior = self.directory / 'records' / record['recordId'] / 'record.backup.json'
        self.assertEqual(json.loads(prior.read_text()), record)
        invalid = copy.deepcopy(backup)
        invalid['state']['curriculumId'] = 'not-the-same'
        with self.assertRaises(StoreError):
            self.store.import_record(invalid, {'kind': 'local'}, 'active', record['recordId'], 1)
        self.assertEqual(self.store.get_record(record['recordId']), restored)

    def test_version_two_backup_restores_draft_without_reusing_local_record_id(self):
        record = self.local()
        record['draft']['experiment'] = {'id': None, 'date': '', 'module': self.course['modules'][0]['id'], 'title': '', 'hypothesis': 'Keep me', 'result': ''}
        record = self.store.save_record(record['recordId'], 0, record)
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        other_store = LocalStore(Path(other.name), dict(self.course, id='other-built-in'), validate_curriculum, validate, initial)
        restored = other_store.import_record(record, {'kind': 'local'}, 'active')
        self.assertNotEqual(restored['recordId'], record['recordId'])
        self.assertEqual(restored['draft'], record['draft'])

    def test_corrupt_and_future_records_are_preserved(self):
        record = self.local()
        target = self.directory / 'records' / record['recordId'] / 'record.json'
        for data in ['{broken', json.dumps(dict(record, version=99))]:
            target.write_text(data)
            with self.assertRaises(StoreError):
                self.store.library()
            self.assertEqual(target.read_text(), data)

    def test_corrupt_legacy_file_is_not_replaced(self):
        target = self.directory / self.course['id'] / 'state.json'
        target.parent.mkdir()
        target.write_text('{broken')
        with self.assertRaises(StoreError):
            self.local()
        self.assertEqual(target.read_text(), '{broken')
        self.assertFalse((self.directory / 'records').exists())

    def test_symlink_and_traversal_are_rejected(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        (self.directory / 'records').symlink_to(outside.name)
        with self.assertRaises(StoreError):
            self.local()
        self.assertEqual(list(Path(outside.name).iterdir()), [])
        with self.assertRaises(StoreError):
            self.store.get_record('../secret')

    def test_unknown_origin_and_invalid_numbers_are_rejected(self):
        for origin in [{'kind': 'cloud'}, {'kind': 'local', 'accountId': 'unexpected'}]:
            with self.assertRaises(StoreError):
                self.store.import_record(self.backup(), origin, 'active')
        record = self.local()
        record['state']['weeklyHours'] = float('nan')
        with self.assertRaises(StoreError):
            self.store.save_record(record['recordId'], 0, record)

    def test_legacy_state_write_preserves_record_only_fields(self):
        record = self.local()
        record['status'] = 'saved'
        record['view']['selectedModuleId'] = self.course['modules'][1]['id']
        record['draft']['experiment'] = {'id': None, 'date': '', 'module': self.course['modules'][0]['id'], 'title': '', 'hypothesis': 'Keep draft', 'result': ''}
        record = self.store.save_record(record['recordId'], 0, record)
        state = copy.deepcopy(record['state'])
        state['weeklyHours'] = 3
        self.store.save_legacy_state(self.course['id'], state)
        restored = self.local()
        self.assertEqual(restored['draft'], record['draft'])
        self.assertEqual(restored['view'], record['view'])
        self.assertEqual(restored['status'], 'saved')
        self.assertEqual(restored['state']['revision'], 2)

    def test_legacy_export_marker_and_extensions_survive_migration(self):
        backup = self.backup()
        backup['format'] = 'touchline-backup'
        backup['curriculum']['id'] = 'imported-course'
        backup['curriculum']['customResources'] = ['legacy extension']
        backup['state']['curriculumId'] = 'imported-course'
        backup['state']['customReflection'] = 'Keep this note'
        restored = self.store.import_record(backup, {'kind': 'local'}, 'active')
        self.assertEqual(restored['curriculum']['customResources'], ['legacy extension'])
        self.assertEqual(restored['state']['customReflection'], 'Keep this note')

    def test_imported_legacy_course_migrates_without_changing_either_original(self):
        course = copy.deepcopy(self.course)
        course['id'] = 'legacy-imported'
        course['version'] = 1
        course['customResources'] = ['legacy extension']
        folder = self.directory / 'curricula'
        folder.mkdir()
        course_file = folder / 'legacy-imported.json'
        course_file.write_text(json.dumps(course))
        state_file = self.directory / course['id'] / 'state.json'
        state_file.parent.mkdir()
        state = initial(course)
        state.update(revision=4, customReflection='Legacy note')
        state_file.write_text(json.dumps(state))
        originals = [p.read_bytes() for p in [course_file, state_file]]
        record = self.store.local_record(course['id'])
        self.assertEqual(record['state']['revision'], 4)
        self.assertEqual(record['state']['customReflection'], 'Legacy note')
        self.assertEqual(record['curriculum']['customResources'], ['legacy extension'])
        self.assertEqual(self.new_store().local_record(course['id']), record)
        self.assertEqual([p.read_bytes() for p in [course_file, state_file]], originals)

    def test_focus_repair_failure_prevents_reactivation(self):
        record = self.local()
        self.store.save_library(0, record['recordId'])
        record['status'] = 'paused'
        paused = self.store.save_record(record['recordId'], 0, record)
        active = dict(paused, status='active')
        target = self.directory / 'library.json'
        real_replace = Path.replace
        def failing_replace(path, destination):
            if Path(destination) == target:
                raise OSError('simulated full disk')
            return real_replace(path, destination)
        with patch.object(Path, 'replace', failing_replace):
            with self.assertRaises(OSError):
                self.store.save_record(record['recordId'], 1, active)
        self.assertEqual(self.new_store().get_record(record['recordId'])['status'], 'paused')
        self.assertIsNone(self.new_store().library()['focusRecordId'])
        self.store.save_record(record['recordId'], 1, active)
        self.assertIsNone(self.store.library()['focusRecordId'])

    def test_bad_legacy_course_blocks_all_migration_before_writes(self):
        folder = self.directory / 'curricula'
        folder.mkdir()
        target = folder / 'bad.json'
        target.write_text(json.dumps(dict(self.course, id='bad', version=99)))
        with self.assertRaises(StoreError):
            self.store.library()
        self.assertFalse((self.directory / 'records').exists())
        self.assertEqual(json.loads(target.read_text())['version'], 99)

    def test_corrupt_library_cannot_be_overwritten(self):
        record = self.local()
        target = self.directory / 'library.json'
        target.write_text('{broken')
        with self.assertRaises(StoreError):
            self.store.save_library(0, record['recordId'])
        with self.assertRaises(StoreError):
            self.store.save_record(record['recordId'], 0, record)
        self.assertEqual(target.read_text(), '{broken')
        self.assertEqual(self.local()['state']['revision'], 0)


import test_server
from urllib.parse import urlencode


class RecordHTTPTests(unittest.TestCase):
    setUp = test_server.HubTests.setUp
    tearDown = test_server.HubTests.tearDown
    request = test_server.HubTests.request

    @classmethod
    def setUpClass(cls):
        cls.course = json.loads((ROOT / 'curriculum.json').read_text())

    def scope(self):
        return {'kind': 'cloud', 'hubId': 'adcd44aa-85da-4548-84bc-1ada69c19099',
                'backendOrigin': 'https://one.supabase.co', 'accountId': str(uuid4())}

    def query(self, origin):
        return '?' + urlencode({k: v for k, v in origin.items() if k != 'kind'})

    def test_record_roundtrip_export_and_stale_response(self):
        status, record = self.request('GET', '/api/record?plan=soccer-ml')
        self.assertEqual(status, 200)
        route = '/api/records/' + record['recordId']
        self.assertEqual(self.request('GET', route + '/export'), (200, record))
        record['draft']['experiment'] = {'id': None, 'date': '', 'module': 'm01', 'title': '', 'hypothesis': 'Retain unfinished work', 'result': ''}
        status, saved = self.request('PUT', route, {'expectedRevision': 0, 'record': record})
        self.assertEqual(status, 200)
        self.assertEqual(saved['state']['revision'], 1)
        status, error = self.request('PUT', route, {'expectedRevision': 0, 'record': record})
        self.assertEqual(status, 409)
        self.assertEqual(error['code'], 'revision_conflict')
        self.assertEqual(error['currentRevision'], 1)
        self.assertFalse(error['retryable'])
        self.assertEqual(self.request('GET', route)[1], saved)

    def test_scope_is_required_complete_and_matching(self):
        origin = self.scope()
        payload = {'source': {'format': 'touchline-backup', 'curriculum': self.course, 'state': initial(self.course)}, 'origin': origin, 'status': 'active'}
        self.assertEqual(self.request('POST', '/api/import', payload)[0], 400)
        status, record = self.request('POST', '/api/import' + self.query(origin), payload)
        self.assertEqual(status, 201)
        route = '/api/records/' + record['recordId']
        self.assertEqual(self.request('GET', route)[0], 404)
        self.assertEqual(self.request('GET', route + self.query(origin))[1], record)
        self.assertEqual(len(self.request('GET', '/api/library')[1]['records']), 1)
        self.assertEqual(len(self.request('GET', '/api/library' + self.query(origin))[1]['records']), 2)
        self.assertEqual(self.request('GET', '/api/library?hubId=' + origin['hubId'])[0], 400)
        self.assertEqual(self.request('GET', route + self.query(dict(origin, accountId=str(uuid4()))))[0], 404)
        self.assertEqual(self.request('POST', '/api/import' + self.query(origin), payload)[0], 409)
        self.assertEqual(len(self.request('GET', '/api/curricula')[1]), 1)

    def test_library_focus_cas_and_lifecycle(self):
        library = self.request('GET', '/api/library')[1]
        record_id = library['records'][0]['recordId']
        status, saved = self.request('PUT', '/api/library', {'expectedRevision': library['revision'], 'focusRecordId': record_id})
        self.assertEqual(status, 200)
        self.assertEqual(saved['focusRecordId'], record_id)
        self.assertEqual(self.request('PUT', '/api/library', {'expectedRevision': 0, 'focusRecordId': None})[0], 409)
        route = '/api/records/' + record_id
        record = self.request('GET', route)[1]
        record['status'] = 'completed'
        self.assertEqual(self.request('PUT', route, {'expectedRevision': 0, 'record': record})[0], 200)
        self.assertIsNone(self.request('GET', '/api/library')[1]['focusRecordId'])
        self.assertEqual(self.request('PUT', '/api/library', {'expectedRevision': 2, 'focusRecordId': record_id})[0], 400)

    def test_bad_requests_do_not_change_records(self):
        original = self.request('GET', '/api/record')[1]
        route = '/api/records/' + original['recordId']
        for payload in [{}, {'expectedRevision': True, 'record': original}, {'expectedRevision': 0, 'record': dict(original, unknown=True)}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.request('PUT', route, payload)[0], 400)
                self.assertEqual(self.request('GET', route)[1], original)
        invalid = copy.deepcopy(original)
        invalid['state']['weeklyHours'] = float('inf')
        self.assertEqual(self.request('PUT', route, {'expectedRevision': 0, 'record': invalid})[0], 400)
        self.assertEqual(self.request('GET', '/api/records/not-a-uuid')[0], 400)
        self.assertEqual(self.request('PUT', route, {'expectedRevision': 0, 'record': original}, {'Origin': 'https://foreign.example'})[0], 403)
        self.assertEqual(self.request('POST', '/api/import', {}, {'Content-Type': 'text/plain'})[0], 415)
