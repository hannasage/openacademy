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


class RestoreSafetyTests(MigrateCase):
    def setUp(self):
        super().setUp()
        lesson_migrate.migrate(self.lessons, self.local)
        self.record_path = self.data / 'records' / SOCCER / 'record.json'
        self.snapshots = self.data / '_lessons' / 'snapshots' / 's03'

    def save_later_work(self):
        record = self.local.get_record(SOCCER)
        record['state']['modules']['m03'] = {'status': 'active', 'tasks': [True, False, False, False], 'notes': 'later work', 'evidence': '', 'hours': 1}
        self.local.save_record(SOCCER, record['state']['revision'], record)

    def test_a_record_saved_after_the_snapshot_is_not_overwritten_without_force(self):
        self.save_later_work()
        before = tree(self.data)
        with self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertEqual((caught.exception.code, caught.exception.status), ('newer_than_snapshot', 409))
        self.assertEqual(caught.exception.details, [{'path': f'records/{SOCCER}/record.json'}])
        self.assertEqual(tree(self.data), before)

    def test_force_replaces_a_newer_record_and_keeps_its_bytes(self):
        self.save_later_work()
        later = self.record_path.read_bytes()
        snapshot = (self.snapshots / SOCCER / 'record.json').read_bytes()
        result = lesson_migrate.restore_originals(self.lessons, self.local, confirm=True, force=True)
        self.assertEqual(result['restored'], [f'records/{SOCCER}/record.json'])
        self.assertEqual(self.record_path.read_bytes(), snapshot)
        kept = list((self.data / '_lessons' / 'snapshots' / 's03-replaced' / SOCCER).glob('record.json.*'))
        self.assertEqual([k.read_bytes() for k in kept], [later])

    def test_force_is_a_separate_flag_on_the_command_line(self):
        self.save_later_work()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(lesson_migrate.main(['restore', '--confirm', '--data-dir', str(self.data)]), 1)
        self.assertIn('newer_than_snapshot', err.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(lesson_migrate.main(['restore', '--confirm', '--force', '--data-dir', str(self.data)]), 0)

    def test_a_state_file_with_a_newer_revision_is_also_protected(self):
        legacy = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, legacy, True)
        data = legacy / 'data'
        shutil.copytree(GOLDEN / 'legacy-layout', data)
        lessons, local = LessonStore(data, clock=CLOCK), LocalStore(data, built_in(), validate_curriculum, validate, initial)
        lesson_migrate.migrate(lessons, local)
        manifest = json.loads(next((data / '_lessons' / 'snapshots' / 's03').glob('*/manifest.json')).read_text())
        item = next(f for f in manifest['files'] if f['name'] == 'state.json')
        live = data / item['path']
        state = json.loads(live.read_text())
        state['revision'] = state['revision'] + 5
        live.write_text(json.dumps(state))
        with self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.restore_originals(lessons, local, confirm=True)
        self.assertEqual(caught.exception.code, 'newer_than_snapshot')
        self.assertIn(item['path'], [d['path'] for d in caught.exception.details])

    def test_dot_entries_in_the_snapshot_folder_are_ignored(self):
        (self.snapshots / '.DS_Store').write_bytes(b'junk')
        self.record_path.write_bytes(b'x')
        self.assertEqual(lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)['status'], 'restored')

    def test_other_strays_in_the_snapshot_folder_still_stop_the_restore(self):
        (self.snapshots / 'stray.txt').write_bytes(b'junk')
        with self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertEqual(caught.exception.code, 'corrupt_file')

    def test_an_unfinished_snapshot_stops_the_restore_with_an_error(self):
        self.record_path.write_bytes(b'x')
        (self.snapshots / SOCCER / 'manifest.json').unlink()
        before = tree(self.data)
        with self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.restore_originals(self.lessons, self.local, confirm=True)
        self.assertEqual(caught.exception.code, 'corrupt_file')
        self.assertIn('unfinished', str(caught.exception))
        self.assertEqual(tree(self.data), before)

    def damaged_second_file(self):
        """A second original is missing, so the restore has two files to put back."""
        legacy = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, legacy, True)
        data = legacy / 'data'
        shutil.copytree(GOLDEN / 'legacy-layout', data)
        lessons, local = LessonStore(data, clock=CLOCK), LocalStore(data, built_in(), validate_curriculum, validate, initial)
        lesson_migrate.migrate(lessons, local)
        files = []
        for manifest in sorted((data / '_lessons' / 'snapshots' / 's03').glob('*/manifest.json')):
            files += [data / f['path'] for f in json.loads(manifest.read_text())['files']]
        for path in files:
            path.write_bytes(b'{"damaged": true}')
        return data, lessons, local, sorted(files)

    def test_a_failure_part_way_puts_back_every_original_it_had_replaced(self):
        data, lessons, local, files = self.damaged_second_file()
        before = tree(data)
        real = LessonStore._atomic
        count = {'n': 0}

        def fail_on_second_original(store, path, content):
            if not str(path).startswith(str(data / '_lessons')):
                count['n'] += 1
                if count['n'] == 2:
                    raise OSError('disk full')
            return real(store, path, content)

        self.assertGreaterEqual(len(files), 2)
        with mock.patch.object(LessonStore, '_atomic', fail_on_second_original), self.assertRaises(OSError):
            lesson_migrate.restore_originals(lessons, local, confirm=True)
        after = tree(data)
        originals = {k: v for k, v in after.items() if not k.startswith('_lessons')}
        self.assertEqual(originals, {k: v for k, v in before.items() if not k.startswith('_lessons')})

    def test_an_undo_that_fails_raises_partial_restore_with_the_files_already_restored(self):
        data, lessons, local, files = self.damaged_second_file()
        real = LessonStore._atomic
        state = {'originals': 0, 'broken': False}

        def break_after_first(store, path, content):
            if not str(path).startswith(str(data / '_lessons')):
                if state['broken']:
                    raise OSError('gone')
                state['originals'] += 1
                if state['originals'] == 2:
                    state['broken'] = True
                    raise OSError('disk full')
            return real(store, path, content)

        with mock.patch.object(LessonStore, '_atomic', break_after_first), self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.restore_originals(lessons, local, confirm=True)
        self.assertEqual((caught.exception.code, caught.exception.status), ('partial_restore', 500))
        self.assertEqual(len(caught.exception.details), 1)
        self.assertTrue((data / caught.exception.details[0]['path']).exists())


class FrozenMapGrowthTests(MigrateCase):
    def test_a_module_added_to_the_curriculum_is_added_to_the_map(self):
        lesson_migrate.migrate(self.lessons, self.local)
        record = self.local.get_record(SOCCER)
        extra = copy.deepcopy(record['curriculum']['modules'][-1])
        extra['id'] = 'm14'
        extra['title'] = 'A module added later'
        record['curriculum']['modules'].append(extra)
        self.local.save_record(SOCCER, record['state']['revision'], record)
        path = self.data / '_lessons' / 'map' / 'soccer-ml.json'
        old = json.loads(path.read_text())
        result = lesson_migrate.refresh_progress(self.lessons, self.local)
        grown = json.loads(path.read_text())
        self.assertEqual(grown['modules']['m14'], 'soccer-ml-m14')
        self.assertEqual({k: v for k, v in grown['modules'].items() if k != 'm14'}, old['modules'], 'ids already in the map never change')
        self.assertTrue((self.data / '_lessons' / 'progress' / SOCCER / 'soccer-ml-m14.json').is_file())
        self.assertEqual(result['status'], 'refreshed')
        self.assertEqual(lesson_migrate.refresh_progress(self.lessons, self.local)['status'], 'current')


class RollbackHonestyTests(MigrateCase):
    def test_a_failed_refresh_puts_back_the_progress_files_it_had_replaced(self):
        lesson_migrate.migrate(self.lessons, self.local)
        record = self.local.get_record(SOCCER)
        for module in ('m03', 'm04'):
            record['state']['modules'][module] = {'status': 'active', 'tasks': [True, False, False, False], 'notes': module, 'evidence': '', 'hours': 1}
        self.local.save_record(SOCCER, record['state']['revision'], record)
        before = tree(self.data)
        real = LessonStore._atomic
        count = {'n': 0}

        def fail_late(store, path, data):
            count['n'] += 1
            if count['n'] == 3:
                raise OSError('disk full')
            return real(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', fail_late), self.assertRaises(OSError):
            lesson_migrate.refresh_progress(self.lessons, self.local)
        self.assertGreaterEqual(count['n'], 3)
        self.assertEqual(tree(self.data), before)

    def test_an_undo_that_cannot_finish_is_reported_with_the_paths(self):
        lesson_migrate.migrate(self.lessons, self.local)
        record = self.local.get_record(SOCCER)
        record['state']['modules']['m03'] = {'status': 'active', 'tasks': [True, False, False, False], 'notes': 'x', 'evidence': '', 'hours': 1}
        self.local.save_record(SOCCER, record['state']['revision'], record)
        real = LessonStore._atomic
        state = {'n': 0}

        def fail_then_stay_broken(store, path, data):
            state['n'] += 1
            if state['n'] >= 3:
                raise OSError('disk full')
            return real(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', fail_then_stay_broken), self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.refresh_progress(self.lessons, self.local)
        self.assertEqual(caught.exception.code, 'rollback_incomplete')
        self.assertTrue(all(d['path'].startswith('_lessons/progress/') for d in caught.exception.details))

    def test_a_snapshot_copy_that_does_not_match_its_source_stops_the_migration_and_leaves_no_trace(self):
        before = tree(self.data)
        real = LessonStore._atomic

        def damage_snapshots(store, path, data):
            if 'snapshots' in Path(path).parts and Path(path).name == 'record.json':
                data = data[:-1] + b'!'
            return real(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', damage_snapshots), self.assertRaises(LessonStoreError) as caught:
            lesson_migrate.migrate(self.lessons, self.local)
        self.assertEqual(caught.exception.code, 'corrupt_file')
        self.assertIn('snapshot copy', str(caught.exception))
        self.assertEqual(tree(self.data), before)

    def test_migrate_removes_stale_leftovers_first(self):
        import os
        import time
        stale = self.data / '_lessons' / '.staging-dead'
        stale.mkdir(parents=True)
        old = time.time() - 7200
        os.utime(stale, (old, old))
        lesson_migrate.migrate(self.lessons, self.local)
        self.assertFalse(stale.exists())


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
