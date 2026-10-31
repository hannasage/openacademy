"""The lesson version store: write-once versions, pins, atomic import, silent preview."""
import hashlib
import json
import os
import stat
import time
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import lesson_store
from lesson_store import LessonStore, LessonStoreError, clean_file_name, version_key

VALID = ROOT / 'tests' / 'fixtures' / 'contracts' / 'valid'
INVALID = ROOT / 'tests' / 'fixtures' / 'contracts' / 'invalid'
FIXED_CLOCK = lambda: '2026-01-02T03:04:05Z'  # noqa: E731


def fixture(name, folder=VALID):
    return (folder / name).read_bytes()


def variant(name, **changes):
    document = json.loads(fixture(name))
    document.update(changes)
    return (json.dumps(document, indent=2) + '\n').encode()


def tree(directory):
    """Every path under a folder, with a digest for files. Empty folders count."""
    directory = Path(directory)
    result = {}
    for path in sorted(directory.rglob('*')):
        key = str(path.relative_to(directory))
        result[key] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else 'dir'
    return result


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.store = LessonStore(self.data, clock=FIXED_CLOCK)

    def files(self, *items):
        return [(name, data) for name, data in items]


class PreviewTests(StoreCase):
    def test_preview_writes_nothing_and_creates_no_folder(self):
        before = tree(self.data)
        result = self.store.preview_import(self.files(('m.json', fixture('lesson-module-minimal.json'))))
        self.assertTrue(result['importable'])
        self.assertEqual(result['files'][0]['id'], 'hello-module')
        self.assertEqual(result['files'][0]['status'], 'new')
        self.assertEqual(result['files'][0]['pin'], 'will-pin')
        self.assertEqual(tree(self.data), before)
        self.assertFalse((self.data / '_lessons').exists())

    def test_preview_leaves_a_populated_tree_unchanged(self):
        self.store.import_files(self.files(('m.json', fixture('lesson-module-minimal.json'))))
        before = tree(self.data)
        self.store.preview_import(self.files(('n.json', variant('lesson-module-minimal.json', version='1.1.0'))))
        self.assertEqual(tree(self.data), before)

    def test_preview_reports_each_damaged_file(self):
        result = self.store.preview_import(self.files(
            ('good.json', fixture('lesson-module-minimal.json')),
            ('bad.json', fixture('lesson-module-damaged-truncated.json', INVALID))))
        self.assertFalse(result['importable'])
        self.assertEqual([p['file'] for p in result['problems']], ['bad.json'])
        self.assertEqual(result['problems'][0]['code'], 'invalid_lesson')

    def test_preview_reports_newer_than_pin_and_packet_modules(self):
        self.store.import_files(self.files(('m.json', fixture('lesson-module-minimal.json'))))
        result = self.store.preview_import(self.files(('n.json', variant('lesson-module-minimal.json', version='1.1.0'))))
        self.assertEqual(result['files'][0]['pin'], 'newer-than-pin')
        self.assertEqual(result['files'][0]['pinnedVersion'], '1.0.0')


class ImportTests(StoreCase):
    def test_import_stores_exact_bytes_and_a_source_record(self):
        data = fixture('lesson-module-minimal.json')
        self.store.import_files(self.files(('dir/m.json', data)))
        folder = self.data / '_lessons' / 'modules' / 'hello-module' / '1.0.0'
        self.assertEqual((folder / 'module.json').read_bytes(), data)
        source = json.loads((folder / 'source.json').read_text())
        self.assertEqual(source['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(source['fileName'], 'm.json')
        self.assertEqual(source['importedAt'], '2026-01-02T03:04:05Z')
        self.assertEqual(source['size'], len(data))

    def test_first_version_is_pinned_and_a_later_version_never_moves_the_pin(self):
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        self.assertEqual(self.store.pins()['pins'], {'hello-module': '1.0.0'})
        self.store.import_files(self.files(('b.json', variant('lesson-module-minimal.json', version='1.1.0'))))
        self.assertEqual(self.store.pins()['pins'], {'hello-module': '1.0.0'})
        self.assertEqual(self.store.versions('hello-module'), ['1.0.0', '1.1.0'])

    def test_listing_offers_the_newer_version_without_switching(self):
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        entry = self.store.list_modules()['modules'][0]
        self.assertIsNone(entry['newerVersionAvailable'])
        self.store.import_files(self.files(('b.json', variant('lesson-module-minimal.json', version='1.10.0'))))
        self.store.import_files(self.files(('c.json', variant('lesson-module-minimal.json', version='1.2.0'))))
        entry = self.store.list_modules()['modules'][0]
        self.assertEqual(entry['pinnedVersion'], '1.0.0')
        self.assertEqual(entry['newerVersionAvailable'], '1.10.0')
        self.assertEqual(entry['versions'], ['1.0.0', '1.2.0', '1.10.0'])

    def test_same_id_and_version_with_other_bytes_is_rejected_and_changes_nothing(self):
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        before = tree(self.data)
        changed = variant('lesson-module-minimal.json', title='A different title')
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('b.json', changed)))
        self.assertEqual(caught.exception.code, 'version_conflict')
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(tree(self.data), before)

    def test_same_bytes_again_is_a_quiet_no_op(self):
        data = fixture('lesson-module-minimal.json')
        self.store.import_files(self.files(('a.json', data)))
        before = tree(self.data)
        result = self.store.import_files(self.files(('again.json', data)))
        self.assertEqual(result['imported'][0]['status'], 'already-stored')
        self.assertEqual(tree(self.data), before)

    def test_two_files_in_one_import_with_the_same_version_and_different_bytes_are_rejected(self):
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(
                ('a.json', fixture('lesson-module-minimal.json')),
                ('b.json', variant('lesson-module-minimal.json', title='Other'))))
        self.assertEqual(caught.exception.code, 'version_conflict')
        self.assertFalse((self.data / '_lessons').exists())

    def test_one_bad_file_stops_the_whole_import_before_any_write(self):
        for bad in ('lesson-module-damaged-truncated.json', 'lesson-module-extra-property.json',
                    'lesson-module-unknown-major.json', 'lesson-module-hint-ladder-out-of-order.json'):
            with self.subTest(bad=bad):
                with self.assertRaises(LessonStoreError):
                    self.store.import_files(self.files(
                        ('good.json', fixture('lesson-module-minimal.json')),
                        ('bad.json', fixture(bad, INVALID))))
                self.assertFalse((self.data / '_lessons').exists())

    def test_text_that_is_not_utf8_is_refused(self):
        data = fixture('lesson-module-minimal.json').replace(b'Read this', b'Read \xff')
        self.assertIn(b'\xff', data)
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('bad.json', data)))
        self.assertEqual(caught.exception.status, 422)
        self.assertFalse((self.data / '_lessons').exists())

    def test_unsupported_version_has_its_own_code(self):
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('bad.json', fixture('lesson-module-unknown-major.json', INVALID))))
        self.assertEqual(caught.exception.code, 'unsupported_version')

    def test_a_file_over_the_cap_is_refused(self):
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('big.json', b'{' + b' ' * (5 * 1024 * 1024) + b'}')))
        self.assertEqual(caught.exception.code, 'payload_too_large')
        self.assertEqual(caught.exception.status, 413)
        self.assertFalse((self.data / '_lessons').exists())

    def test_a_packet_needs_its_modules_in_the_import_or_the_store(self):
        before = tree(self.data)
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('p.json', fixture('packet-one-module.json'))))
        self.assertEqual(caught.exception.code, 'missing_module')
        self.assertEqual(tree(self.data), before)
        self.store.import_files(self.files(('m.json', fixture('lesson-module-minimal.json'))))
        self.store.import_files(self.files(('p.json', fixture('packet-one-module.json'))))
        self.assertEqual(self.store.get_packet('single-lesson', '1.0.0')['id'], 'single-lesson')

    def test_a_packet_and_its_modules_import_together(self):
        self.store.import_files(self.files(
            ('p.json', fixture('packet-one-module.json')),
            ('m.json', fixture('lesson-module-minimal.json'))))
        source = self.store.source('module', 'hello-module', '1.0.0')
        self.assertEqual(source['packetIds'], ['single-lesson'])
        self.assertEqual(self.store.pins()['pins'], {'hello-module': '1.0.0'})

    def test_text_input_is_stored_as_utf8_bytes(self):
        data = variant('lesson-module-minimal.json', title='Café lesson')
        self.store.import_files(self.files(('m.json', data.decode('utf-8'))))
        self.assertEqual(self.store.module_bytes('hello-module', '1.0.0'), data)

    def test_bad_arguments_are_refused(self):
        for bad in (None, [], 'x', [('only-name',)], [('a', 5)], [('a', '\ud800')]):
            with self.subTest(bad=bad), self.assertRaises(LessonStoreError):
                self.store.import_files(bad)


class AtomicTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))

    def test_failure_while_writing_leaves_the_tree_byte_identical(self):
        before = tree(self.data)
        new = self.files(('b.json', variant('lesson-module-minimal.json', version='1.1.0')),
                         ('c.json', fixture('lesson-module-full.json')))
        original = LessonStore._atomic
        calls = {'count': 0}

        def fail_on_third(store, path, data):
            calls['count'] += 1
            if calls['count'] == 3:
                raise OSError('disk full')
            return original(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', fail_on_third), self.assertRaises(OSError):
            self.store.import_files(new)
        self.assertEqual(tree(self.data), before)

    def test_failure_at_every_write_step_leaves_no_trace(self):
        new = self.files(('b.json', variant('lesson-module-minimal.json', version='1.1.0')),
                         ('c.json', fixture('lesson-module-full.json')))
        original = LessonStore._atomic
        for step in range(1, 6):  # four staged files, then the pin file
            with self.subTest(step=step):
                before = tree(self.data)
                calls = {'count': 0}

                def fail_at(store, path, data, step=step, calls=calls):
                    calls['count'] += 1
                    if calls['count'] == step:
                        raise OSError('disk full')
                    return original(store, path, data)

                with mock.patch.object(LessonStore, '_atomic', fail_at), self.assertRaises(OSError):
                    self.store.import_files(new)
                self.assertEqual(tree(self.data), before)

    def test_failure_on_a_rename_leaves_no_trace(self):
        before = tree(self.data)
        new = self.files(('b.json', variant('lesson-module-minimal.json', version='1.1.0')),
                         ('c.json', fixture('lesson-module-full.json')))
        real = Path.rename
        calls = {'count': 0}

        def flaky(path, target):
            calls['count'] += 1
            if calls['count'] == 2:
                raise OSError('rename failed')
            return real(path, target)

        with mock.patch.object(Path, 'rename', flaky), self.assertRaises(OSError):
            self.store.import_files(new)
        self.assertEqual(tree(self.data), before)

    def test_failure_on_the_first_ever_import_removes_the_lessons_folder(self):
        data = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, data, True)
        store = LessonStore(data)
        with mock.patch.object(LessonStore, '_atomic', side_effect=OSError('nope')), self.assertRaises(OSError):
            store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        self.assertEqual(tree(data), {})

    def test_cancelled_import_is_a_preview_and_leaves_the_tree_identical(self):
        before = tree(self.data)
        self.store.preview_import(self.files(('b.json', fixture('lesson-module-full.json'))))
        self.assertEqual(tree(self.data), before)

    def test_no_temporary_or_staging_files_remain_after_success(self):
        self.store.import_files(self.files(('c.json', fixture('lesson-module-full.json'))))
        names = [p.name for p in (self.data / '_lessons').rglob('*')]
        self.assertFalse([n for n in names if n.startswith('.')])

    def test_pins_file_is_written_last(self):
        order = []
        original = LessonStore._atomic

        def record(store, path, data):
            order.append(Path(path).name)
            return original(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', record):
            self.store.import_files(self.files(('c.json', fixture('lesson-module-full.json'))))
        self.assertEqual(order[-1], 'pins.json')


class DurabilityTests(StoreCase):
    def test_atomic_flushes_the_file_and_then_its_folder(self):
        kinds = []
        real = os.fsync

        def watch(descriptor):
            kinds.append('folder' if stat.S_ISDIR(os.fstat(descriptor).st_mode) else 'file')
            return real(descriptor)

        with mock.patch('os.fsync', watch):
            self.store._atomic(self.data / '_lessons' / 'x.json', b'{}')
        self.assertEqual(kinds, ['file', 'folder'])

    def test_a_crash_at_the_rename_keeps_the_old_file_and_leaves_no_temporary_file(self):
        path = self.data / '_lessons' / 'pins.json'
        self.store._atomic(path, b'old')
        with mock.patch('os.replace', side_effect=OSError('power cut')), self.assertRaises(OSError):
            self.store._atomic(path, b'new bytes')
        self.assertEqual(path.read_bytes(), b'old')
        self.assertEqual([p.name for p in path.parent.iterdir()], ['pins.json'])

    def test_every_folder_is_flushed_before_the_pin_file_and_the_lessons_folder_after_it(self):
        events = []
        real_sync, real_replace = lesson_store._fsync_dir, os.replace

        def sync(path):
            events.append(('sync', Path(path)))
            return real_sync(path)

        def replace(source, target):
            events.append(('replace', Path(target)))
            return real_replace(source, target)

        with mock.patch.object(lesson_store, '_fsync_dir', sync), mock.patch('os.replace', replace):
            self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        root = self.data / '_lessons'
        pin_at = events.index(('replace', root / 'pins.json'))
        before = {path for kind, path in events[:pin_at] if kind == 'sync'}
        for needed in (root, root / 'modules', root / 'modules' / 'hello-module', root / 'modules' / 'hello-module' / '1.0.0', self.data):
            self.assertIn(needed, before, str(needed.relative_to(self.data)))
        self.assertTrue(any(path.name.startswith('.staging-') for path in before), 'the stage folder')
        self.assertIn(('sync', root), events[pin_at + 1:])


class StaleLeftoverTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        self.root = self.data / '_lessons'

    def age(self, path, seconds):
        stamp = time.time() - seconds
        os.utime(path, (stamp, stamp))

    def leftovers(self):
        old_stage = self.root / '.staging-old'
        (old_stage / '0').mkdir(parents=True)
        (old_stage / '0' / 'module.json').write_bytes(b'{}')
        new_stage = self.root / '.staging-new'
        new_stage.mkdir()
        old_tmp = self.root / 'modules' / '.touchline-old.tmp'
        old_tmp.write_bytes(b'x')
        new_tmp = self.root / 'modules' / '.touchline-new.tmp'
        new_tmp.write_bytes(b'x')
        self.age(old_stage, 7200)
        self.age(old_tmp, 7200)
        return old_stage, new_stage, old_tmp, new_tmp

    def test_a_write_removes_only_stale_leftovers(self):
        old_stage, new_stage, old_tmp, new_tmp = self.leftovers()
        self.store.import_files(self.files(('c.json', fixture('lesson-module-full.json'))))
        self.assertFalse(old_stage.exists())
        self.assertFalse(old_tmp.exists())
        self.assertTrue(new_stage.exists(), 'a recent staging folder may belong to a writer that is working now')
        self.assertTrue(new_tmp.exists())
        self.assertTrue((self.root / 'modules' / 'hello-module' / '1.0.0' / 'module.json').is_file(), 'real files stay')

    def test_a_write_that_changes_nothing_sweeps_nothing_and_a_preview_never_sweeps(self):
        old_stage, _, old_tmp, _ = self.leftovers()
        self.store.preview_import(self.files(('c.json', fixture('lesson-module-full.json'))))
        self.assertTrue(old_stage.exists() and old_tmp.exists())

    def test_the_sweep_never_follows_a_link(self):
        outside = self.data / 'outside'
        outside.mkdir()
        (outside / 'keep.txt').write_bytes(b'x')
        link = self.root / '.staging-link'
        link.symlink_to(outside, target_is_directory=True)
        self.age(link, 7200)
        self.store.sweep_stale()
        self.assertTrue((outside / 'keep.txt').exists())
        self.assertTrue(link.is_symlink())

    def test_a_crash_between_folder_renames_is_harmless_and_a_reimport_finishes_the_job(self):
        # State after a power cut: the module folder is placed, the pin file is not, a staging folder is left.
        full = self.files(('c.json', fixture('lesson-module-full.json')))
        item = self.store.plan_import(full)['items'][0]
        item['source'] = lesson_store.source_record('module', item['id'], item['version'], item['sha256'], item['size'], 'c.json', FIXED_CLOCK(), [])
        self.store.write_new([item], pins=None)
        dead = self.root / '.staging-dead'
        (dead / '1').mkdir(parents=True)
        self.age(dead, 7200)
        listing = self.store.list_modules()
        self.assertEqual({m['id']: m['pinnedVersion'] for m in listing['modules']}, {'hello-module': '1.0.0', 'full-module': None})
        result = self.store.import_files(full)
        self.assertEqual([i['status'] for i in result['imported']], ['already-stored'])
        self.assertEqual(self.store.pins()['pins']['full-module'], '2.1.0')
        self.assertFalse(dead.exists())
        self.assertEqual(self.store.get_module('full-module')['id'], 'full-module')


class RollbackReportTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))

    def fresh_item(self):
        plan = self.store.plan_import(self.files(('c.json', fixture('lesson-module-full.json'))))
        item = plan['items'][0]
        item['source'] = lesson_store.source_record('module', item['id'], item['version'], item['sha256'], item['size'], 'c.json', FIXED_CLOCK(), [])
        return item

    def test_a_failure_after_a_file_was_replaced_puts_the_old_bytes_back(self):
        pins = self.store.pins()
        before = tree(self.data)
        original = LessonStore._atomic
        extra = [('extra.json', b'old extra')]
        self.store.write_new([], extra_files=extra)  # the file exists, so the next write replaces it
        before = tree(self.data)

        failed = []

        def fail_on_pins(store, path, data):
            if Path(path).name == 'pins.json' and not failed:
                failed.append(path)
                raise OSError('disk full')
            return original(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', fail_on_pins), self.assertRaises(OSError):
            self.store.write_new([self.fresh_item()], extra_files=[('extra.json', b'new extra')],
                                 pins={'version': 1, 'revision': pins['revision'] + 1, 'pins': dict(pins['pins'], **{'full-module': '2.1.0'})})
        self.assertEqual(tree(self.data), before)
        self.assertEqual((self.data / '_lessons' / 'extra.json').read_bytes(), b'old extra')

    def test_a_rollback_that_cannot_restore_a_file_says_so_and_names_it(self):
        self.store.write_new([], extra_files=[('extra.json', b'old extra')])
        original = LessonStore._atomic
        state = {'failed': False}

        def fail(store, path, data):
            if Path(path).name == 'pins.json':
                state['failed'] = True
                raise OSError('disk full')
            if state['failed']:
                raise OSError('still full')
            return original(store, path, data)

        with mock.patch.object(LessonStore, '_atomic', fail), self.assertRaises(LessonStoreError) as caught:
            self.store.write_new([], extra_files=[('extra.json', b'new extra')], pins={'version': 1, 'revision': 9, 'pins': {}})
        self.assertEqual(caught.exception.code, 'rollback_incomplete')
        self.assertEqual(caught.exception.status, 500)
        self.assertIn('_lessons/extra.json', str(caught.exception))
        self.assertIn({'path': '_lessons/extra.json'}, caught.exception.details)
        self.assertNotIn(str(self.data), str(caught.exception))

    def test_a_rollback_that_cannot_remove_a_placed_folder_says_so(self):
        original = shutil.rmtree

        def stubborn(path, *args, **kwargs):
            if Path(path).name == '2.1.0':
                raise PermissionError('locked')
            return original(path, *args, **kwargs)

        def fail_pins(store, path, data):
            if Path(path).name == 'pins.json' and not failed:
                failed.append(path)
                raise OSError('disk full')
            return real(store, path, data)

        failed = []

        real = LessonStore._atomic
        with mock.patch.object(LessonStore, '_atomic', fail_pins), mock.patch.object(shutil, 'rmtree', stubborn), self.assertRaises(LessonStoreError) as caught:
            self.store.write_new([self.fresh_item()], pins={'version': 1, 'revision': 5, 'pins': {}})
        self.assertEqual(caught.exception.code, 'rollback_incomplete')
        self.assertIn('_lessons/modules/full-module/2.1.0', str(caught.exception))


class MissingDataFolderTests(unittest.TestCase):
    def test_import_creates_a_data_folder_that_does_not_exist_yet(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / 'fresh-data'
            store = LessonStore(data, clock=FIXED_CLOCK)
            store.import_files([('a.json', fixture('lesson-module-minimal.json'))])
            self.assertEqual(store.pins()['pins'], {'hello-module': '1.0.0'})
            self.assertTrue((data / '_lessons' / 'modules' / 'hello-module' / '1.0.0' / 'module.json').is_file())

    def test_a_failed_import_into_a_missing_data_folder_removes_what_it_made(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / 'fresh-data'
            store = LessonStore(data, clock=FIXED_CLOCK)
            with mock.patch.object(LessonStore, '_atomic', side_effect=OSError('nope')), self.assertRaises(OSError):
                store.import_files([('a.json', fixture('lesson-module-minimal.json'))])
            self.assertFalse(data.exists())


def big_module(identifier, blocks=3, size=50000, character='\U0001F600'):
    """A valid module whose text is as costly to escape as possible: four byte characters, 12 bytes each in a backup."""
    document = json.loads(fixture('lesson-module-minimal.json'))
    document['id'] = identifier
    document['blocks'] = [{'type': 'text', 'id': f'b{n}', 'body': character * size} for n in range(blocks)]
    return (json.dumps(document, indent=2, ensure_ascii=False) + '\n').encode()


class QuotaTests(StoreCase):
    def test_a_full_store_refuses_more_with_store_full_and_changes_nothing(self):
        self.store.import_files(self.files(('a.json', big_module('big-one')), ('b.json', big_module('big-two'))))
        before = tree(self.data)
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('c.json', big_module('big-three'))))
        self.assertEqual((caught.exception.code, caught.exception.status), ('store_full', 413))
        self.assertEqual(tree(self.data), before)
        preview = self.store.preview_import(self.files(('c.json', big_module('big-three'))))
        self.assertFalse(preview['importable'])
        self.assertEqual(preview['problems'][0]['code'], 'store_full')
        self.assertEqual(tree(self.data), before)

    def test_a_full_store_still_exports_and_restores_inside_the_5_mb_cap(self):
        self.store.import_files(self.files(('a.json', big_module('big-one')), ('b.json', big_module('big-two'))))
        # Fill what is left with small modules until the store says no.
        for number in range(lesson_store.MAX_STORE_VERSIONS):
            try:
                self.store.import_files(self.files((f'm{number}.json', big_module(f'small-{number}', blocks=1, size=5000))))
            except LessonStoreError as full:
                self.assertEqual(full.code, 'store_full')
                break
        else:
            self.fail('the store never filled')
        usage, _ = self.store.usage()
        self.assertLessEqual(usage, lesson_store.MAX_STORE_BYTES)
        import lesson_backup
        import lesson_contract
        backup = lesson_backup.export_backup(self.store, clock=FIXED_CLOCK)
        size = len(json.dumps(backup).encode())
        self.assertLessEqual(size, lesson_contract.MAX_BYTES)
        self.assertLessEqual(len(json.dumps({'source': backup, 'filename': 'x.json'}).encode()), lesson_contract.MAX_BYTES, 'the restore request fits too')
        with tempfile.TemporaryDirectory() as other:
            target = LessonStore(other, clock=FIXED_CLOCK)
            lesson_backup.restore_backup(target, backup)
            self.assertEqual(target.list_modules(), self.store.list_modules())

    def test_the_estimate_is_never_below_the_real_size_of_the_backup(self):
        import lesson_backup
        long_name = '\u00e9' * 100 + '.json'
        for number in range(6):
            self.store.import_files(self.files((long_name, variant('lesson-module-minimal.json', id=f'mod-{number}'))))
        self.store.import_files(self.files(('packet.json', fixture('packet-one-module.json')), ('m.json', fixture('lesson-module-minimal.json'))))
        estimate, count = self.store.usage()
        real = len(json.dumps(lesson_backup.export_backup(self.store, clock=FIXED_CLOCK)).encode())
        self.assertEqual(count, 8)
        self.assertGreaterEqual(estimate, real)
        self.assertLess(estimate - real, 8 * 2048, 'the estimate stays close')

    def test_the_number_of_versions_is_limited(self):
        with mock.patch.object(lesson_store, 'MAX_STORE_VERSIONS', 2):
            self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json')), ('b.json', variant('lesson-module-minimal.json', version='1.1.0'))))
            with self.assertRaises(LessonStoreError) as caught:
                self.store.import_files(self.files(('c.json', variant('lesson-module-minimal.json', version='1.2.0'))))
        self.assertEqual(caught.exception.code, 'store_full')
        self.assertEqual(self.store.versions('hello-module'), ['1.0.0', '1.1.0'])

    def test_importing_what_is_already_stored_never_trips_the_limit(self):
        self.store.import_files(self.files(('a.json', big_module('big-one')), ('b.json', big_module('big-two'))))
        result = self.store.import_files(self.files(('a.json', big_module('big-one'))))
        self.assertEqual(result['imported'][0]['status'], 'already-stored')

    def test_restoring_into_a_store_that_would_overflow_is_refused(self):
        import lesson_backup
        self.store.import_files(self.files(('a.json', big_module('big-one')), ('b.json', big_module('big-two'))))
        backup = lesson_backup.export_backup(self.store, clock=FIXED_CLOCK)
        with tempfile.TemporaryDirectory() as other:
            target = LessonStore(other, clock=FIXED_CLOCK)
            target.import_files([('c.json', big_module('other-big')), ('d.json', big_module('other-big-two'))])
            before = tree(other)
            with self.assertRaises(LessonStoreError) as caught:
                lesson_backup.restore_backup(target, backup)
            self.assertEqual(caught.exception.code, 'store_full')
            self.assertEqual(tree(other), before)


class PinTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        self.store.import_files(self.files(('b.json', variant('lesson-module-minimal.json', version='1.1.0'))))

    def test_a_pin_moves_only_with_an_explicit_confirm(self):
        revision = self.store.pins()['revision']
        before = tree(self.data)
        for confirm in (False, None, 1, 'true', 'yes'):
            with self.subTest(confirm=confirm), self.assertRaises(LessonStoreError) as caught:
                self.store.set_pin('hello-module', '1.1.0', confirm, revision)
            self.assertEqual(caught.exception.code, 'confirmation_required')
        self.assertEqual(tree(self.data), before)
        result = self.store.set_pin('hello-module', '1.1.0', True, revision)
        self.assertEqual(self.store.pins()['pins']['hello-module'], '1.1.0')
        self.assertIsNone(result['modules'][0]['newerVersionAvailable'])
        self.assertEqual(self.store.pins()['revision'], revision + 1)

    def test_a_stale_revision_is_refused(self):
        with self.assertRaises(LessonStoreError) as caught:
            self.store.set_pin('hello-module', '1.1.0', True, 0)
        self.assertEqual(caught.exception.code, 'revision_conflict')
        self.assertEqual(caught.exception.current_revision, 1)
        with self.assertRaises(LessonStoreError):
            self.store.set_pin('hello-module', '1.1.0', True, None)

    def test_an_unknown_version_cannot_be_pinned(self):
        with self.assertRaises(LessonStoreError) as caught:
            self.store.set_pin('hello-module', '9.9.9', True, 1)
        self.assertEqual(caught.exception.status, 404)
        with self.assertRaises(LessonStoreError):
            self.store.set_pin('../x', '1.0.0', True, 1)

    def test_pinning_the_current_version_writes_nothing(self):
        before = tree(self.data)
        self.store.set_pin('hello-module', '1.0.0', True, 1)
        self.assertEqual(tree(self.data), before)

    def test_a_pin_to_a_missing_version_in_the_file_is_reported_as_damage(self):
        (self.data / '_lessons' / 'pins.json').write_text(json.dumps(
            {'version': 1, 'revision': 1, 'pins': {'hello-module': '7.0.0'}}))
        with self.assertRaises(LessonStoreError) as caught:
            self.store.pins()
        self.assertEqual(caught.exception.code, 'corrupt_file')


class ReadTests(StoreCase):
    def test_reading_a_store_that_does_not_exist_writes_nothing(self):
        self.assertEqual(self.store.list_modules(), {'revision': 0, 'modules': []})
        self.assertEqual(self.store.pins(), {'version': 1, 'revision': 0, 'pins': {}})
        self.assertEqual(tree(self.data), {})

    def test_tampered_module_bytes_are_reported_not_served(self):
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        path = self.data / '_lessons' / 'modules' / 'hello-module' / '1.0.0' / 'module.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaises(LessonStoreError) as caught:
            self.store.get_module('hello-module', '1.0.0')
        self.assertEqual(caught.exception.code, 'corrupt_file')

    def test_damaged_pin_file_is_preserved(self):
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        path = self.data / '_lessons' / 'pins.json'
        path.write_text('{damaged')
        with self.assertRaises(LessonStoreError) as caught:
            self.store.list_modules()
        self.assertEqual(caught.exception.code, 'corrupt_file')
        self.assertEqual(path.read_text(), '{damaged')

    def test_symbolic_links_are_refused(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (self.data / '_lessons').symlink_to(outside)
        with self.assertRaises(LessonStoreError) as caught:
            self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        self.assertEqual(caught.exception.code, 'unsafe_path')
        self.assertEqual(list(outside.iterdir()), [])

    def test_get_module_uses_the_pin_by_default(self):
        self.store.import_files(self.files(('a.json', fixture('lesson-module-minimal.json'))))
        self.store.import_files(self.files(('b.json', variant('lesson-module-minimal.json', version='1.1.0'))))
        self.assertEqual(self.store.get_module('hello-module')['version'], '1.0.0')
        self.assertEqual(self.store.get_module('hello-module', '1.1.0')['version'], '1.1.0')

    def test_all_soccer_modules_and_packet_import_and_list_in_order(self):
        files = [(p.name, p.read_bytes()) for p in sorted(VALID.glob('lesson-module-soccer-m*.json'))]
        files.append(('packet.json', fixture('packet-soccer-ml.json')))
        self.store.import_files(files)
        listing = self.store.list_modules()['modules']
        self.assertEqual(len(listing), 13)
        self.assertTrue(all(m['pinnedVersion'] == '1.0.0' for m in listing))


class HelperTests(unittest.TestCase):
    def test_file_names_lose_paths_and_control_characters(self):
        self.assertEqual(clean_file_name('a/b\\c.json'), 'c.json')
        self.assertEqual(clean_file_name('x‮y.json\n'), 'xy.json')
        self.assertEqual(len(clean_file_name('a' * 500)), lesson_store.MAX_FILE_NAME)
        self.assertEqual(clean_file_name(None), '')

    def test_versions_sort_by_number_not_text(self):
        self.assertEqual(sorted(['1.10.0', '1.2.0', '0.9.9'], key=version_key), ['0.9.9', '1.2.0', '1.10.0'])


if __name__ == '__main__':
    unittest.main()
