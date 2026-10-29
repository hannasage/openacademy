import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from local_store import LocalStore, StoreError
from server import initial, validate, validate_curriculum


class ImportPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.course = json.loads((Path(__file__).resolve().parents[1] / 'curriculum.json').read_text())
        self.store = LocalStore(self.path, self.course, validate_curriculum, validate, initial)
        self.local = self.store.local_record(self.course['id'])

    def source(self):
        course = copy.deepcopy(self.course)
        course['id'] = 'another-topic'
        return {'curriculum': course, 'state': initial(course)}

    def snapshot(self):
        return {str(p.relative_to(self.path)): p.read_bytes() for p in self.path.rglob('*') if p.is_file()}

    def test_preview_is_read_only_and_import_keeps_focus(self):
        self.store.save_library(0, self.local['recordId'])
        before = self.snapshot()
        preview = self.store.preview_import(self.source(), {'kind': 'local'}, 'saved')
        self.assertEqual(preview['curriculum']['id'], 'another-topic')
        self.assertEqual(self.snapshot(), before)
        imported = self.store.import_record(self.source(), {'kind': 'local'}, 'saved')
        self.assertEqual(imported['status'], 'saved')
        self.assertEqual(self.store.library()['focusRecordId'], self.local['recordId'])

    def test_invalid_source_reports_resource_or_module_field_without_writes(self):
        before = self.snapshot()
        source = self.source()
        key = next(iter(source['curriculum']['resources']))
        source['curriculum']['resources'][key]['url'] = 'javascript:alert(1)'
        with self.assertRaises(StoreError) as problem:
            self.store.preview_import(source, {'kind': 'local'}, 'active')
        self.assertEqual(problem.exception.field, f'curriculum.resources.{key}.url')
        source = self.source()
        del source['curriculum']['modules'][1]['title']
        with self.assertRaises(StoreError) as problem:
            self.store.preview_import(source, {'kind': 'local'}, 'active')
        self.assertEqual(problem.exception.field, 'curriculum.modules[1].title')
        self.assertEqual(self.snapshot(), before)

    def test_duplicate_and_failed_write_never_replace_existing_records(self):
        before = self.snapshot()
        with self.assertRaises(StoreError) as problem:
            self.store.preview_import({'curriculum':self.course,'state':initial(self.course)}, {'kind':'local'}, 'active')
        self.assertEqual(problem.exception.code, 'identity_collision')
        with patch.object(self.store, '_write', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.store.import_record(self.source(), {'kind':'local'}, 'active')
        self.assertEqual(self.snapshot(), before)

    def test_restore_preview_rejects_stale_revision_and_retains_draft(self):
        incoming = copy.deepcopy(self.local)
        incoming['draft']['experiment'] = {'id':None,'date':'','module':self.course['modules'][0]['id'],'title':'','hypothesis':'An unfinished idea','result':'Evidence: https://example.com/notebook'}
        preview = self.store.preview_import(incoming, {'kind':'local'}, 'active', self.local['recordId'], 0)
        self.assertEqual(preview['draft'], incoming['draft'])
        self.store.save_record(self.local['recordId'], 0, self.local)
        with self.assertRaises(StoreError) as problem:
            self.store.import_record(incoming, {'kind':'local'}, 'active', self.local['recordId'], 0)
        self.assertEqual(problem.exception.code, 'revision_conflict')

    def test_unmigrated_legacy_duplicate_is_rejected_without_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            store = LocalStore(Path(folder), self.course, validate_curriculum, validate, initial)
            with self.assertRaises(StoreError) as problem:
                store.preview_import({'curriculum':self.course,'state':initial(self.course)}, {'kind':'local'}, 'saved')
            self.assertEqual(problem.exception.code, 'identity_collision')
            self.assertFalse((Path(folder) / 'records').exists())

    def test_all_module_errors_name_the_field(self):
        mutations = [('id', self.course['modules'][0]['id']), ('tasks', []), ('resources', ['missing']), ('weekEnd', 1000), ('prerequisites', ['missing'])]
        for field, value in mutations:
            with self.subTest(field=field):
                source = self.source()
                source['curriculum']['modules'][1][field] = value
                with self.assertRaises(StoreError) as problem:
                    self.store.preview_import(source, {'kind':'local'}, 'active')
                self.assertEqual(problem.exception.field, f'curriculum.modules[1].{field}')

    def test_damaged_local_record_recovers_from_backup_and_preserves_bytes(self):
        self.local['state']['weeklyHours'] = 7
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        record_path.write_bytes(b'{damaged')
        option = self.store.recovery_options()[0]
        recovered = self.store.recover_record(option['recordId'], option['damagedDigest'])
        self.assertEqual(recovered['state']['weeklyHours'], self.course['weeklyHours'])
        self.assertEqual(recovered['recordId'], self.local['recordId'])
        self.assertEqual(next(record_path.parent.glob('record.damaged-*.json')).read_bytes(), b'{damaged')
        self.assertEqual(json.loads((record_path.parent / 'record.backup.json').read_text())['state']['revision'], 0)

    def test_recovery_rejects_changed_bytes_and_never_lists_cloud_backup(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        record_path.write_bytes(b'{damaged')
        option = self.store.recovery_options()[0]
        record_path.write_bytes(b'{different damage')
        with self.assertRaises(StoreError):
            self.store.recover_record(option['recordId'], option['damagedDigest'])
        self.assertEqual(record_path.read_bytes(), b'{different damage')
        backup_path = record_path.parent / 'record.backup.json'
        backup = json.loads(backup_path.read_text())
        backup['origin'] = {'kind':'cloud','hubId':'11111111-1111-4111-8111-111111111111','accountId':'22222222-2222-4222-8222-222222222222','backendOrigin':'https://example.com'}
        backup_path.write_text(json.dumps(backup))
        self.assertEqual(self.store.recovery_options(), [])

    def test_recovery_failed_write_retains_damage_and_rejects_previous_writer(self):
        saved = self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        record_path.write_bytes(b'{damaged')
        option = self.store.recovery_options()[0]
        with patch.object(self.store, '_write', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.store.recover_record(option['recordId'], option['damagedDigest'])
        self.assertEqual(record_path.read_bytes(), b'{damaged')
        self.store.recover_record(option['recordId'], option['damagedDigest'])
        with self.assertRaises(StoreError) as problem:
            self.store.save_record(saved['recordId'], saved['state']['revision'], saved)
        self.assertEqual(problem.exception.code, 'revision_conflict')

    def test_recovery_rejects_replaced_backup(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        record_path.write_bytes(b'{damaged')
        option = self.store.recovery_options()[0]
        backup_path = record_path.parent / 'record.backup.json'
        backup = json.loads(backup_path.read_text())
        backup['state']['weeklyHours'] = 5
        backup_path.write_text(json.dumps(backup))
        with self.assertRaises(StoreError):
            self.store.recover_record(option['recordId'], option['damagedDigest'])
        self.assertEqual(record_path.read_bytes(), b'{damaged')

    def test_future_record_is_not_offered_or_modified_by_recovery(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        future = json.loads(record_path.read_text())
        future['version'] = 3
        record_path.write_text(json.dumps(future))
        before = self.snapshot()
        self.assertEqual(self.store.recovery_options(), [])
        with self.assertRaises(StoreError) as problem:
            self.store.recover_record(self.local['recordId'], 'unused')
        self.assertEqual(problem.exception.code, 'unsupported_version')
        with self.assertRaises(StoreError) as listing:
            self.store.library()
        self.assertIn('Update Touchline', str(listing.exception))
        self.assertEqual(self.snapshot(), before)

    def test_future_record_with_new_fields_is_not_a_recovery_candidate(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        future = json.loads(record_path.read_text())
        future.update(version=3, newVersionField={'keep': 'new data'})
        record_path.write_text(json.dumps(future))
        before = self.snapshot()
        self.assertEqual(self.store.recovery_options(), [])
        with self.assertRaises(StoreError) as problem:
            self.store.recover_record(self.local['recordId'], 'unused')
        self.assertEqual(problem.exception.code, 'unsupported_version')
        self.assertEqual(self.snapshot(), before)

    def test_repeated_recovery_advances_revision_and_rejects_prior_recovery_writer(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        backup_path = record_path.parent / 'record.backup.json'
        original_backup = backup_path.read_bytes()
        record_path.write_bytes(b'{damaged')
        first_option = self.store.recovery_options()[0]
        first = self.store.recover_record(first_option['recordId'], first_option['damagedDigest'])
        record_path.write_bytes(b'{damaged')
        second_option = self.store.recovery_options()[0]
        self.assertNotEqual(first_option['damagedDigest'], second_option['damagedDigest'])
        second = self.store.recover_record(second_option['recordId'], second_option['damagedDigest'])
        self.assertGreater(second['state']['revision'], first['state']['revision'])
        with self.assertRaises(StoreError) as problem:
            self.store.save_record(first['recordId'], first['state']['revision'], first)
        self.assertEqual(problem.exception.code, 'revision_conflict')
        self.assertEqual(backup_path.read_bytes(), original_backup)
        self.assertEqual(self.store.get_record(second['recordId']), second)

    def test_interrupted_recovery_reserves_revision_before_record_write(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        record_path.write_bytes(b'{damaged')
        option = self.store.recovery_options()[0]
        original_write = self.store._write
        def fail_record(path, value, backup=False):
            if path == record_path:
                raise OSError('record replacement failed after reservation')
            return original_write(path, value, backup)
        with patch.object(self.store, '_write', side_effect=fail_record):
            with self.assertRaises(OSError):
                self.store.recover_record(option['recordId'], option['damagedDigest'])
        reserved = json.loads((record_path.parent / 'recovery-state.json').read_text())['revision']
        self.assertEqual(record_path.read_bytes(), b'{damaged')
        with self.assertRaises(StoreError) as stale:
            self.store.recover_record(option['recordId'], option['damagedDigest'])
        self.assertEqual(stale.exception.code, 'revision_conflict')
        fresh = self.store.recovery_options()[0]
        recovered = self.store.recover_record(fresh['recordId'], fresh['damagedDigest'])
        self.assertGreater(recovered['state']['revision'], reserved)
        self.assertEqual(json.loads((record_path.parent / 'record.backup.json').read_text())['state']['revision'], 0)

    def test_unreadable_recovery_history_fails_without_overwriting_any_file(self):
        self.store.save_record(self.local['recordId'], 0, self.local)
        record_path = self.path / 'records' / self.local['recordId'] / 'record.json'
        record_path.write_bytes(b'{damaged')
        (record_path.parent / 'recovery-state.json').write_text('{broken')
        before = self.snapshot()
        with self.assertRaises(StoreError):
            self.store.recovery_options()
        with self.assertRaises(StoreError):
            self.store.recover_record(self.local['recordId'], 'unused')
        self.assertEqual(self.snapshot(), before)
