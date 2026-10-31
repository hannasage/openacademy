"""The lesson backup: export, check, and all-or-nothing restore, plus the help store."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import lesson_backup
from lesson_store import LessonStore, LessonStoreError

CONTRACTS = ROOT / 'tests' / 'fixtures' / 'contracts'
VALID = CONTRACTS / 'valid'
BACKUPS = CONTRACTS / 'lesson-backup'
MANIFEST = json.loads((CONTRACTS / 'lesson-backup-conformance.json').read_text())
CLOCK = lambda: '2026-01-02T03:04:05Z'  # noqa: E731
HELP = json.loads((VALID / 'help-record-nudge-null-attempt.json').read_text())
HELP_TWO = json.loads((VALID / 'help-record-partial-example-student.json').read_text())
HELP_THREE = json.loads((VALID / 'help-record-full-answer-agent.json').read_text())


def tree(directory):
    directory = Path(directory)
    result = {}
    for path in sorted(directory.rglob('*')):
        key = str(path.relative_to(directory))
        result[key] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else 'dir'
    return result


def fixture(name):
    return (VALID / name).read_bytes()


def newer_minimal():
    document = json.loads(fixture('lesson-module-minimal.json'))
    document['version'] = '1.1.0'
    return (json.dumps(document, indent=2) + '\n').encode()


class BackupCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'a'
        self.other = Path(self.temp.name) / 'b'
        self.data.mkdir()
        self.other.mkdir()
        self.store = LessonStore(self.data, clock=CLOCK)
        self.target = LessonStore(self.other, clock=CLOCK)

    def fill(self, store=None):
        store = store or self.store
        store.import_files([
            ('minimal.json', fixture('lesson-module-minimal.json')),
            ('minimal-1.1.json', newer_minimal()),
            ('full.json', fixture('lesson-module-full.json')),
            ('packet.json', fixture('packet-one-module.json'))])
        self.put_help(store, 'full-module', [HELP, HELP_TWO], 2)

    def put_help(self, store, module_id, records, revision):
        store._atomic(store.root / 'help' / f'{module_id}.json', lesson_backup.help_file_bytes(module_id, revision, records))

    def lessons_tree(self, directory):
        return tree(directory)


class ConformanceTests(BackupCase):
    def test_the_manifest_lists_every_fixture_file(self):
        on_disk = sorted(f'{folder}/{p.name}' for folder in ('valid', 'invalid') for p in (BACKUPS / folder).iterdir())
        self.assertEqual(sorted(entry['file'] for entry in MANIFEST), on_disk)
        self.assertEqual(len({entry['name'] for entry in MANIFEST}), len(MANIFEST))

    def test_every_fixture_gives_its_expected_result(self):
        for entry in MANIFEST:
            with self.subTest(entry['name']):
                before = tree(self.other)
                text = (BACKUPS / entry['file']).read_bytes()
                document = json.loads(text)
                preview = lesson_backup.preview_restore(self.target, text)
                schema_errors = lesson_backup.backup_registry().validate(lesson_backup.BACKUP_SCHEMA_ID, document)
                if entry['expect'] == 'valid':
                    self.assertTrue(preview['importable'], preview)
                    self.assertEqual(schema_errors, [])
                else:
                    self.assertFalse(preview['importable'])
                    self.assertTrue(preview['problems'])
                    if entry['stage'] != 'version':
                        self.assertEqual(bool(schema_errors), entry['stage'] == 'schema')
                    if entry['stage'] == 'version':
                        self.assertEqual(preview['problems'][0]['code'], 'unsupported_version')
                    with self.assertRaises(LessonStoreError):
                        lesson_backup.restore_backup(self.target, text)
                self.assertEqual(tree(self.other), before)


class ExportTests(BackupCase):
    def test_export_of_an_empty_store_is_valid_and_writes_nothing(self):
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        self.assertEqual(lesson_backup.backup_registry().validate(lesson_backup.BACKUP_SCHEMA_ID, backup), [])
        self.assertEqual((backup['modules'], backup['packets'], backup['help']), ([], [], []))
        self.assertEqual(tree(self.data), {})

    def test_export_holds_exact_text_pins_and_help(self):
        self.fill()
        before = tree(self.data)
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        self.assertEqual(tree(self.data), before)
        self.assertEqual(backup['format'], 'schola-lesson-backup')
        self.assertEqual([(m['id'], m['version']) for m in backup['modules']],
                         [('full-module', '2.1.0'), ('hello-module', '1.0.0'), ('hello-module', '1.1.0')])
        self.assertEqual(backup['modules'][1]['text'].encode(), fixture('lesson-module-minimal.json'))
        self.assertEqual(backup['modules'][1]['source']['packetIds'], ['single-lesson'])
        self.assertEqual(backup['pins']['pins'], {'full-module': '2.1.0', 'hello-module': '1.0.0'})
        self.assertEqual(backup['help'], [{'moduleId': 'full-module', 'revision': 2, 'records': [HELP, HELP_TWO]}])
        self.assertEqual(lesson_backup.backup_registry().validate(lesson_backup.BACKUP_SCHEMA_ID, backup), [])

    def test_export_refuses_a_file_too_large_to_restore(self):
        self.fill()
        with mock.patch.object(lesson_backup, 'MAX_BYTES', 100), self.assertRaises(LessonStoreError) as caught:
            lesson_backup.export_backup(self.store)
        self.assertEqual(caught.exception.status, 413)

    def test_all_soccer_modules_round_trip(self):
        files = [(p.name, p.read_bytes()) for p in sorted(VALID.glob('lesson-module-soccer-m*.json'))]
        files.append(('packet.json', fixture('packet-soccer-ml.json')))
        self.store.import_files(files)
        lesson_backup.restore_backup(self.target, lesson_backup.export_backup(self.store, clock=CLOCK))
        self.assertEqual(tree(self.other), tree(self.data))


class RestoreTests(BackupCase):
    def test_restore_into_an_empty_folder_reproduces_the_tree(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        result = lesson_backup.restore_backup(self.target, json.loads(json.dumps(backup)))
        self.assertTrue(result['importable'])
        self.assertEqual(tree(self.other), tree(self.data))
        self.assertEqual(self.target.list_modules(), self.store.list_modules())

    def test_restore_from_text_and_bytes(self):
        self.fill()
        text = json.dumps(lesson_backup.export_backup(self.store, clock=CLOCK))
        lesson_backup.restore_backup(self.target, text.encode())
        self.assertEqual(tree(self.other), tree(self.data))

    def test_a_second_restore_changes_nothing(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        lesson_backup.restore_backup(self.target, backup)
        before = tree(self.other)
        lesson_backup.restore_backup(self.target, backup)
        self.assertEqual(tree(self.other), before)

    def test_preview_writes_nothing_not_even_the_folder(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        preview = lesson_backup.preview_restore(self.target, backup)
        self.assertTrue(preview['importable'])
        self.assertEqual(preview['counts'], {'modules': 3, 'packets': 1, 'pins': 2, 'helpRecords': 2})
        self.assertEqual(sorted(preview['pinsToSet']), ['full-module', 'hello-module'])
        self.assertEqual({e['status'] for e in preview['files']}, {'new'})
        self.assertEqual(tree(self.other), {})

    def test_every_kind_of_damage_changes_nothing(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        self.target.import_files([('x.json', fixture('lesson-module-minimal.json'))])
        before = tree(self.other)

        def mutated(change):
            copy_ = copy.deepcopy(backup)
            change(copy_)
            return copy_

        damaged = {
            'truncated': json.dumps(backup)[:-40],
            'not json': 'nonsense',
            'not an object': [],
            'digest': mutated(lambda b: b['modules'][0].update(sha256='0' * 64)),
            'text': mutated(lambda b: b['modules'][0].update(text=b['modules'][0]['text'] + ' ')),
            'extra field': mutated(lambda b: b.update(extra=1)),
            'pin': mutated(lambda b: b['pins']['pins'].update({'missing-module': '1.0.0'})),
            'help task': mutated(lambda b: b['help'][0]['records'][0].update(taskId='nope')),
            'help module': mutated(lambda b: b['help'][0].update(moduleId='unknown-module')),
            'major': mutated(lambda b: b.update(schemaVersion='2.0')),
            'other format': {'format': 'touchline-backup', 'curriculum': {}, 'state': {}},
        }
        for name, value in damaged.items():
            with self.subTest(name):
                with self.assertRaises(LessonStoreError):
                    lesson_backup.restore_backup(self.target, value)
                self.assertEqual(tree(self.other), before)

    def test_a_conflicting_version_stops_everything(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        document = json.loads(fixture('lesson-module-minimal.json'))
        document['title'] = 'Changed title'
        self.target.import_files([('x.json', (json.dumps(document) + '\n').encode())])
        before = tree(self.other)
        with self.assertRaises(LessonStoreError) as caught:
            lesson_backup.restore_backup(self.target, backup)
        self.assertEqual(caught.exception.code, 'version_conflict')
        self.assertEqual(tree(self.other), before)

    def test_restore_never_moves_an_existing_pin(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        self.target.import_files([('a.json', fixture('lesson-module-minimal.json')), ('b.json', newer_minimal())])
        self.target.set_pin('hello-module', '1.1.0', True, 1)
        lesson_backup.restore_backup(self.target, backup)
        pins = self.target.pins()['pins']
        self.assertEqual(pins['hello-module'], '1.1.0')
        self.assertEqual(pins['full-module'], '2.1.0')

    def test_help_records_merge_without_repeats(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        self.target.import_files([('f.json', fixture('lesson-module-full.json'))])
        self.put_help(self.target, 'full-module', [HELP_THREE, HELP], 4)
        lesson_backup.restore_backup(self.target, backup)
        stored = lesson_backup.read_help(self.target, 'full-module')
        self.assertEqual(stored['records'], [HELP_THREE, HELP, HELP_TWO])
        self.assertEqual(stored['revision'], 5)

    def test_a_failed_write_at_any_step_leaves_no_trace(self):
        self.fill()
        backup = lesson_backup.export_backup(self.store, clock=CLOCK)
        real = LessonStore._atomic
        counter = {'n': 0}

        def count(store, path, data):
            counter['n'] += 1
            return real(store, path, data)

        with tempfile.TemporaryDirectory() as dry, mock.patch.object(LessonStore, '_atomic', count):
            lesson_backup.restore_backup(LessonStore(dry), backup)
        total = counter['n']
        self.assertGreaterEqual(total, 8)
        for step in range(1, total + 1):
            counter['at'] = 0

            def fail_at(store, path, data, step=step):
                counter['at'] += 1
                if counter['at'] == step:
                    raise OSError('disk full')
                return real(store, path, data)

            with self.subTest(step=step), mock.patch.object(LessonStore, '_atomic', fail_at), self.assertRaises(OSError):
                lesson_backup.restore_backup(self.target, backup)
            self.assertEqual(tree(self.other), {})
        lesson_backup.restore_backup(self.target, backup)
        self.assertEqual(tree(self.other), tree(self.data))

    def test_the_older_record_backup_format_is_not_a_lesson_backup(self):
        old = json.loads((CONTRACTS / 'valid' / 'legacy-backup.json').read_text()) if (CONTRACTS / 'valid' / 'legacy-backup.json').exists() else {'curriculum': {}, 'state': {}}
        preview = lesson_backup.preview_restore(self.target, old)
        self.assertFalse(preview['importable'])
        self.assertEqual(tree(self.other), {})

    def test_text_over_the_cap_is_refused(self):
        with self.assertRaises(LessonStoreError) as caught:
            lesson_backup.restore_backup(self.target, ' ' * (5 * 1024 * 1024 + 1))
        self.assertEqual(caught.exception.status, 413)


class HelpStoreTests(BackupCase):
    def test_reading_missing_help_writes_nothing(self):
        self.assertEqual(lesson_backup.read_help(self.store, 'full-module'), {'version': 1, 'revision': 0, 'records': []})
        self.assertEqual(tree(self.data), {})

    def test_damaged_help_is_reported_and_kept(self):
        for bad in ('{damaged', json.dumps({'version': 1, 'revision': 0, 'records': [{'moduleId': 'full-module'}]}),
                    json.dumps({'version': 1, 'revision': 0, 'records': [dict(HELP, moduleId='other-module')]})):
            with self.subTest(bad=bad):
                path = self.data / '_lessons' / 'help' / 'full-module.json'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(bad)
                with self.assertRaises(LessonStoreError) as caught:
                    lesson_backup.read_help(self.store, 'full-module')
                self.assertEqual(caught.exception.code, 'corrupt_file')
                self.assertEqual(path.read_text(), bad)

    def test_bad_module_ids_are_refused(self):
        for bad in ('../x', 'A', '', None):
            with self.subTest(bad=bad), self.assertRaises(LessonStoreError):
                lesson_backup.read_help(self.store, bad)


if __name__ == '__main__':
    unittest.main()
