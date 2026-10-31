"""The lesson version store: write-once versions, pins, atomic import, silent preview."""
import hashlib
import json
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
