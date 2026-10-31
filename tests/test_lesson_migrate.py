"""Module progress derived from records, byte copies of originals, and the way back."""
import contextlib
import copy
import hashlib
import io
import json
from http.client import HTTPConnection
from http.server import HTTPServer
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import lesson_map
import lesson_migrate
from lesson_store import LessonStore, LessonStoreError
from local_store import LocalStore
from server import Handler, initial, validate, validate_curriculum

GOLDEN = ROOT / 'tests' / 'fixtures' / 'storage' / 'pre-s03'
LAYOUTS = ('current-layout', 'legacy-layout', 'recovery-layout')
SOCCER = 'ac02873e-ad82-58bc-8266-b1e4abb684f4'
CLOCK = lambda: '2026-01-02T03:04:05Z'  # noqa: E731


def built_in():
    return json.loads((ROOT / 'curriculum.json').read_text())


def tree(directory, skip_lessons=False):
    directory = Path(directory)
    result = {}
    for path in sorted(directory.rglob('*')):
        key = str(path.relative_to(directory))
        if skip_lessons and key.split('/')[0] == '_lessons':
            continue
        result[key] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else 'dir'
    return result


@contextlib.contextmanager
def live(directory):
    server = HTTPServer(('127.0.0.1', 0), Handler)
    server.data_dir = Path(directory)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def get(path):
        connection = HTTPConnection('127.0.0.1', server.server_port)
        connection.request('GET', path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, json.loads(body)

    try:
        yield get
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def plans_of(directory):
    """Every curriculum id that a data folder serves, read through the real server."""
    with live(directory) as get:
        return [c['id'] for c in get('/api/curricula')[1]]


def states_of(directory):
    with live(directory) as get:
        return {plan: get(f'/api/state?plan={plan}') for plan in plans_of(directory)}


class MigrateCase(unittest.TestCase):
    layout = 'current-layout'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'
        shutil.copytree(GOLDEN / self.layout, self.data)
        self.lessons = LessonStore(self.data, clock=CLOCK)
        self.local = LocalStore(self.data, built_in(), validate_curriculum, validate, initial)


class EveryLayoutTests(unittest.TestCase):
    def each_layout(self):
        for layout in LAYOUTS:
            with self.subTest(layout=layout), tempfile.TemporaryDirectory() as temp:
                data = Path(temp) / 'data'
                shutil.copytree(GOLDEN / layout, data)
                yield layout, data, LessonStore(data, clock=CLOCK), LocalStore(data, built_in(), validate_curriculum, validate, initial)

    def test_migrate_adds_files_only_under_lessons_and_changes_no_byte_elsewhere(self):
        for layout, data, lessons, local in self.each_layout():
            before = tree(data)
            result = lesson_migrate.migrate(lessons, local)
            self.assertEqual(result['status'], 'migrated')
            self.assertEqual(tree(data, skip_lessons=True), before)
            self.assertTrue((data / '_lessons' / 'migrated.json').is_file())

    def test_a_second_run_is_a_no_op(self):
        for layout, data, lessons, local in self.each_layout():
            lesson_migrate.migrate(lessons, local)
            before = tree(data)
            self.assertEqual(lesson_migrate.migrate(lessons, local), {'status': 'already-migrated'})
            self.assertEqual(tree(data), before)

    def test_migrate_then_restore_gives_identical_originals_and_state(self):
        for layout, data, lessons, local in self.each_layout():
            originals = tree(data)
            with tempfile.TemporaryDirectory() as other:
                baseline_dir = Path(other) / 'data'
                shutil.copytree(data, baseline_dir)
                baseline = states_of(baseline_dir)
            lesson_migrate.migrate(lessons, local)
            for path in sorted(data.rglob('*')):
                if path.is_file() and path.relative_to(data).parts[0] != '_lessons' and path.name in ('record.json', 'state.json', 'legacy-sample.json'):
                    path.write_bytes(b'{"damaged": true}')
            result = lesson_migrate.restore_originals(lessons, local, confirm=True)
            self.assertIn(result['status'], ('restored', 'unchanged'))
            for key, digest in originals.items():
                self.assertEqual(tree(data, skip_lessons=True).get(key), digest, key)
            self.assertEqual(states_of(data), baseline)

    def test_reads_work_the_same_after_migration(self):
        for layout, data, lessons, local in self.each_layout():
            with tempfile.TemporaryDirectory() as other:
                baseline_dir = Path(other) / 'data'
                shutil.copytree(data, baseline_dir)
                baseline = states_of(baseline_dir)
            lesson_migrate.migrate(lessons, local)
            self.assertEqual(states_of(data), baseline)

    def test_every_snapshot_manifest_matches_its_copies(self):
        for layout, data, lessons, local in self.each_layout():
            lesson_migrate.migrate(lessons, local)
            for folder in (data / '_lessons' / 'snapshots' / 's03').iterdir():
                manifest = json.loads((folder / 'manifest.json').read_text())
                self.assertTrue(manifest['files'])
                for item in manifest['files']:
                    copy_bytes = (folder / item['name']).read_bytes()
                    self.assertEqual(hashlib.sha256(copy_bytes).hexdigest(), item['sha256'])
                    live_file = data / item['path']
                    self.assertEqual(live_file.read_bytes(), copy_bytes)


class CurrentLayoutTests(MigrateCase):
    def test_progress_is_derived_from_the_record(self):
        lesson_migrate.migrate(self.lessons, self.local)
        folder = self.data / '_lessons' / 'progress' / SOCCER
        self.assertEqual(len(list(folder.glob('*.json'))), 13)
        first = json.loads((folder / 'soccer-ml-m01.json').read_text())
        record = json.loads((self.data / 'records' / SOCCER / 'record.json').read_text())
        self.assertEqual(first['status'], 'complete')
        self.assertEqual(first['revision'], record['state']['revision'])
        self.assertEqual(first['source'], {'recordId': SOCCER, 'curriculumId': 'soccer-ml', 'legacyModuleId': 'm01', 'stateRevision': 2})
        self.assertEqual(list(first['tasks']), ['task-1', 'task-2', 'task-3', 'task-4'])
        self.assertTrue(all(first['tasks'].values()))
        self.assertEqual(first['hours'], 6.5)
        self.assertEqual(first['evidence'], record['state']['modules']['m01']['evidence'])
        self.assertEqual([e['id'] for e in first['experiments']], ['experiment-1'])
        second = json.loads((folder / 'soccer-ml-m02.json').read_text())
        self.assertEqual(second['status'], 'active')
        self.assertEqual(second['tasks']['task-1'], True)
        self.assertEqual(second['experiments'], [])
        untouched = json.loads((folder / 'soccer-ml-m03.json').read_text())
        self.assertEqual((untouched['status'], untouched['hours'], untouched['notes']), ('not-started', 0, ''))
        self.assertFalse(any(untouched['tasks'].values()))

    def test_record_level_data_stays_in_the_record(self):
        lesson_migrate.migrate(self.lessons, self.local)
        text = ''.join(p.read_text() for p in (self.data / '_lessons' / 'progress').rglob('*.json'))
        self.assertNotIn('weeklyHours', text)
        self.assertNotIn('startDate', text)
        self.assertNotIn('draft', text)

    def test_the_id_map_is_frozen_and_matches_the_mapper(self):
        lesson_migrate.migrate(self.lessons, self.local)
        stored = json.loads((self.data / '_lessons' / 'map' / 'soccer-ml.json').read_text())
        self.assertEqual(stored, lesson_map.map_curriculum(built_in())['idMap'])
        self.assertEqual(stored['modules']['m01'], 'soccer-ml-m01')

    def test_refresh_rebuilds_only_stale_progress(self):
        lesson_migrate.migrate(self.lessons, self.local)
        self.assertEqual(lesson_migrate.refresh_progress(self.lessons, self.local), {'status': 'current', 'files': 0})
        record = self.local.get_record(SOCCER)
        record['state']['modules']['m03'] = {'status': 'active', 'tasks': [True, False, False, False], 'notes': 'new', 'evidence': '', 'hours': 1}
        self.local.save_record(SOCCER, record['state']['revision'], record)
        before = tree(self.data)
        result = lesson_migrate.refresh_progress(self.lessons, self.local)
        self.assertEqual(result['status'], 'refreshed')
        after = tree(self.data)
        changed = sorted(k for k in after if before.get(k) != after[k])
        # Every lesson carries the new revision stamp; none of them is an original.
        self.assertTrue(all(k.startswith('_lessons/progress/') for k in changed), changed)
        third = json.loads((self.data / '_lessons' / 'progress' / SOCCER / 'soccer-ml-m03.json').read_text())
        self.assertEqual((third['status'], third['notes'], third['revision']), ('active', 'new', 3))
        self.assertEqual(lesson_migrate.refresh_progress(self.lessons, self.local)['status'], 'current')

    def test_refresh_needs_the_migration_first(self):
        with self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.refresh_progress(self.lessons, self.local)
        self.assertEqual(caught.exception.code, 'not_migrated')
        self.assertFalse((self.data / '_lessons').exists())

    def test_read_progress(self):
        lesson_migrate.migrate(self.lessons, self.local)
        self.assertEqual(lesson_migrate.read_progress(self.lessons, SOCCER, 'soccer-ml-m02')['status'], 'active')
        self.assertIsNone(lesson_migrate.read_progress(self.lessons, SOCCER, 'no-such-lesson'))
        with self.assertRaises(Exception):
            lesson_migrate.read_progress(self.lessons, '../x', 'soccer-ml-m02')

    def test_a_failed_write_at_any_step_leaves_nothing_behind(self):
        with tempfile.TemporaryDirectory() as other:
            dry = Path(other) / 'data'
            shutil.copytree(self.data, dry)
            counter = {'count': 0}
            real = LessonStore._atomic

            def count(store, path, data):
                counter['count'] += 1
                return real(store, path, data)

            with mock.patch.object(LessonStore, '_atomic', count):
                lesson_migrate.migrate(LessonStore(dry, clock=CLOCK), LocalStore(dry, built_in(), validate_curriculum, validate, initial))
        total = counter['count']
        self.assertGreater(total, 14)
        before = tree(self.data)
        for step in range(1, total + 1):
            counter['at'] = 0

            def fail_at(store, path, data, step=step):
                counter['at'] += 1
                if counter['at'] == step:
                    raise OSError('disk full')
                return real(store, path, data)

            with self.subTest(step=step), mock.patch.object(LessonStore, '_atomic', fail_at), self.assertRaises(OSError):
                lesson_migrate.migrate(self.lessons, self.local)
            self.assertEqual(tree(self.data), before)
        self.assertEqual(lesson_migrate.migrate(self.lessons, self.local)['status'], 'migrated')

    def test_an_interrupted_run_resumes_and_keeps_the_first_snapshot(self):
        original = (self.data / 'records' / SOCCER / 'record.json').read_bytes()
        lesson_migrate.migrate(self.lessons, self.local)
        (self.data / '_lessons' / 'migrated.json').unlink()
        record = self.local.get_record(SOCCER)
        record['view']['selectedModuleId'] = 'm05'
        self.local.save_record(SOCCER, record['state']['revision'], record)
        self.assertEqual(lesson_migrate.migrate(self.lessons, self.local)['status'], 'migrated')
        kept = (self.data / '_lessons' / 'snapshots' / 's03' / SOCCER / 'record.json').read_bytes()
        self.assertEqual(kept, original)

    def test_restore_needs_an_explicit_confirm_and_writes_nothing_without_it(self):
        lesson_migrate.migrate(self.lessons, self.local)
        (self.data / 'records' / SOCCER / 'record.json').write_bytes(b'x')
        before = tree(self.data)
        for confirm in (False, None, 1, 'true'):
            with self.subTest(confirm=confirm), self.assertRaises(LessonStoreError) as caught:
                lesson_migrate.restore_originals(self.lessons, self.local, confirm)
            self.assertEqual(caught.exception.code, 'confirmation_required')
        self.assertEqual(tree(self.data), before)

    def test_restore_keeps_the_bytes_it_replaces_and_never_deletes(self):
        lesson_migrate.migrate(self.lessons, self.local)
        path = self.data / 'records' / SOCCER / 'record.json'
        original = path.read_bytes()
        path.write_bytes(original + b' ')
        later = path.read_bytes()
        result = lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertEqual(result['restored'], [f'records/{SOCCER}/record.json'])
        self.assertEqual(path.read_bytes(), original)
        kept = list((self.data / '_lessons' / 'snapshots' / 's03-replaced' / SOCCER).glob('record.json.*'))
        self.assertEqual([k.read_bytes() for k in kept], [later])
        self.assertEqual(lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)['status'], 'unchanged')

    def test_restore_brings_back_a_deleted_original(self):
        lesson_migrate.migrate(self.lessons, self.local)
        path = self.data / 'records' / SOCCER / 'record.json'
        original = path.read_bytes()
        path.unlink()
        lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertEqual(path.read_bytes(), original)

    def test_a_tampered_snapshot_stops_the_restore_before_any_write(self):
        lesson_migrate.migrate(self.lessons, self.local)
        (self.data / 'records' / SOCCER / 'record.json').write_bytes(b'x')
        snapshot = self.data / '_lessons' / 'snapshots' / 's03' / SOCCER / 'record.json'
        snapshot.write_bytes(snapshot.read_bytes() + b' ')
        before = tree(self.data)
        with self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertEqual(caught.exception.code, 'corrupt_file')
        self.assertEqual(tree(self.data), before)

    def test_a_manifest_cannot_point_outside_the_data_folder(self):
        lesson_migrate.migrate(self.lessons, self.local)
        path = self.data / '_lessons' / 'snapshots' / 's03' / SOCCER / 'manifest.json'
        manifest = json.loads(path.read_text())
        manifest['files'][0]['path'] = '../outside.json'
        path.write_text(json.dumps(manifest))
        with self.assertRaises(LessonStoreError):
            lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertFalse((self.data.parent / 'outside.json').exists())

    def test_the_command_line_runs_and_reports(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = lesson_migrate.main(['migrate', '--data-dir', str(self.data)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())['status'], 'migrated')
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(lesson_migrate.main(['restore', '--data-dir', str(self.data)]), 1)


class LegacyLayoutTests(MigrateCase):
    layout = 'legacy-layout'

    def test_legacy_ids_come_through_the_mapper_and_records_are_not_created(self):
        self.assertFalse((self.data / 'records').exists())
        lesson_migrate.migrate(self.lessons, self.local)
        self.assertFalse((self.data / 'records').exists())
        maps = sorted(p.name for p in (self.data / '_lessons' / 'map').glob('*.json'))
        self.assertEqual(maps, ['legacy-sample.json', 'soccer-ml.json'])
        folders = sorted(p.name for p in (self.data / '_lessons' / 'progress').iterdir())
        self.assertEqual(len(folders), 2)

    def test_originals_are_snapshotted_including_curricula_files(self):
        lesson_migrate.migrate(self.lessons, self.local)
        names = {}
        for folder in (self.data / '_lessons' / 'snapshots' / 's03').iterdir():
            manifest = json.loads((folder / 'manifest.json').read_text())
            names[manifest['curriculumId']] = sorted(f['path'] for f in manifest['files'])
        self.assertEqual(names['legacy-sample'], ['curricula/legacy-sample.json', 'legacy-sample/state.json'])
        self.assertEqual(names['soccer-ml'], ['soccer-ml/state.json'])

    def test_an_invalid_original_stops_everything_before_any_write(self):
        (self.data / 'legacy-sample' / 'state.json').write_text('{damaged')
        before = tree(self.data)
        with self.assertRaises(Exception):
            lesson_migrate.migrate(self.lessons, self.local)
        self.assertEqual(tree(self.data), before)
        self.assertFalse((self.data / '_lessons').exists())


class IdFallbackTests(MigrateCase):
    layout = 'current-layout'

    def test_ids_that_fail_the_pattern_or_collide_use_the_frozen_fallback(self):
        course = copy.deepcopy(built_in())
        course['id'] = 'odd-ids'
        course['modules'] = course['modules'][:3]
        for module, legacy_id in zip(course['modules'], ('M_01', 'm-01', 'X' * 60)):
            module['id'] = legacy_id
            module['prerequisites'] = []
        for module in course['modules']:
            module['weekEnd'] = min(module['weekEnd'], course['weeks'])
        self.local.import_record({'curriculum': course, 'state': initial(course)}, {'kind': 'local'}, 'active')
        lesson_migrate.migrate(self.lessons, self.local)
        stored = json.loads((self.data / '_lessons' / 'map' / 'odd-ids.json').read_text())
        ids = list(stored['modules'].values())
        self.assertEqual(len(set(ids)), 3)
        self.assertTrue(all(lesson_map.is_valid_lesson_id(i) for i in ids))
        self.assertEqual(stored['modules']['M_01'], 'odd-ids-m-01')
        self.assertRegex(stored['modules']['m-01'], r'^odd-ids-[0-9a-f]{8}$')
        self.assertTrue(stored['modules']['X' * 60].startswith('odd-ids-'))
        # Frozen: another run, even after a refresh, keeps the same table.
        lesson_migrate.refresh_progress(self.lessons, self.local)
        self.assertEqual(json.loads((self.data / '_lessons' / 'map' / 'odd-ids.json').read_text()), stored)


if __name__ == '__main__':
    unittest.main()
