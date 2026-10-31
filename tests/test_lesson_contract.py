"""Tests for the stdlib-only lesson contract validator (lesson_contract.py).

The validator reads the real contracts/*.schema.json files. The shared
conformance manifest is the main guard: every case must give the result and
the stage that the manifest names.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import lesson_contract as lc

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / 'tests' / 'fixtures' / 'contracts'
MANIFEST = FIXTURES / 'lesson-conformance.json'


def expected_for(entry):
    if entry['expect'] == 'valid':
        return True, None
    return False, entry['expect'].split(':', 1)[1]


def mismatches(manifest, fixtures):
    """Return one line for every manifest entry the validator disagrees with."""
    found = []
    for entry in manifest:
        text = (fixtures / entry['file']).read_text(encoding='utf-8')
        result, stage = lc.validate_lesson_text_with_stage(entry['kind'], text)
        ok, reason = expected_for(entry)
        if result['ok'] != ok:
            found.append(f"{entry['name']}: ok {result['ok']} != {ok}")
        elif not ok and result['reason'] != reason:
            found.append(f"{entry['name']}: reason {result['reason']} != {reason}")
        if stage != entry['stage']:
            found.append(f"{entry['name']}: stage {stage} != {entry['stage']}")
    return found


def load_manifest():
    return json.loads(MANIFEST.read_text(encoding='utf-8'))


def good(name):
    return json.loads((FIXTURES / 'valid' / name).read_text(encoding='utf-8'))


def pointers(result):
    return sorted(error['pointer'] for error in result.get('errors', []))


class ConformanceTests(unittest.TestCase):
    def test_every_manifest_case_matches_result_reason_and_stage(self):
        manifest = load_manifest()
        self.assertGreaterEqual(len(manifest), 44)
        for entry in manifest:
            with self.subTest(case=entry['name']):
                text = (FIXTURES / entry['file']).read_text(encoding='utf-8')
                result, stage = lc.validate_lesson_text_with_stage(entry['kind'], text)
                ok, reason = expected_for(entry)
                self.assertEqual(result['ok'], ok, result)
                if ok:
                    self.assertEqual(list(result), ['ok'])
                else:
                    self.assertEqual(result['reason'], reason, result)
                    self.assertTrue(result['errors'])
                    for error in result['errors']:
                        self.assertEqual(sorted(error), ['message', 'pointer'])
                        self.assertIsInstance(error['pointer'], str)
                        self.assertIsInstance(error['message'], str)
                self.assertEqual(stage, entry['stage'])

    def test_manifest_covers_every_kind(self):
        kinds = {entry['kind'] for entry in load_manifest()}
        self.assertEqual(kinds, set(lc.LESSON_CONTRACT_KINDS))

    def test_the_public_text_and_file_entry_points_agree_with_the_staged_one(self):
        for entry in load_manifest():
            with self.subTest(case=entry['name']):
                path = FIXTURES / entry['file']
                text = path.read_text(encoding='utf-8')
                staged, _ = lc.validate_lesson_text_with_stage(entry['kind'], text)
                self.assertEqual(lc.validate_lesson_text(entry['kind'], text), staged)
                self.assertEqual(lc.validate_lesson_file(entry['kind'], path), staged)

    def test_fixture_files_keep_their_bytes_and_times(self):
        before = {}
        for entry in load_manifest():
            path = FIXTURES / entry['file']
            before[path] = (path.read_bytes(), path.stat().st_mtime_ns)
            lc.validate_lesson_file(entry['kind'], path)
        for path, (data, mtime) in before.items():
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(path.stat().st_mtime_ns, mtime)


class MutationTests(unittest.TestCase):
    """Prove the conformance check can fail, using temporary copies only."""

    def make_copy(self):
        folder = tempfile.mkdtemp(prefix='schola-lesson-mutation-')
        self.addCleanup(shutil.rmtree, folder, True)
        target = Path(folder) / 'contracts-fixtures'
        shutil.copytree(FIXTURES, target)
        return target

    def test_the_real_manifest_has_no_mismatch(self):
        self.assertEqual(mismatches(load_manifest(), FIXTURES), [])

    def test_a_flipped_expectation_is_reported_for_every_case(self):
        copy_root = self.make_copy()
        manifest = load_manifest()
        for entry in manifest:
            entry['expect'] = 'invalid:invalid' if entry['expect'] == 'valid' else 'valid'
        (copy_root / 'lesson-conformance.json').write_text(json.dumps(manifest), encoding='utf-8')
        flipped = json.loads((copy_root / 'lesson-conformance.json').read_text(encoding='utf-8'))
        report = mismatches(flipped, copy_root)
        for entry in flipped:
            self.assertTrue(any(line.startswith(entry['name'] + ':') for line in report), entry['name'])

    def test_a_flipped_stage_is_reported(self):
        manifest = load_manifest()
        for entry in manifest:
            entry['stage'] = 'schema' if entry['stage'] == 'semantic' else 'semantic'
        report = mismatches(manifest, FIXTURES)
        self.assertEqual(len(report), len(manifest))

    def test_a_broken_valid_fixture_is_rejected(self):
        copy_root = self.make_copy()
        path = copy_root / 'valid' / 'lesson-module-minimal.json'
        document = json.loads(path.read_text(encoding='utf-8'))
        del document['outcome']
        path.write_text(json.dumps(document), encoding='utf-8')
        result = lc.validate_lesson_file('lesson-module', path)
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'invalid')
        self.assertIn('/outcome', pointers(result))

    def test_a_repaired_invalid_fixture_is_accepted(self):
        copy_root = self.make_copy()
        path = copy_root / 'invalid' / 'lesson-module-self-prerequisite.json'
        document = json.loads(path.read_text(encoding='utf-8'))
        document['prerequisites'] = []
        path.write_text(json.dumps(document), encoding='utf-8')
        self.assertEqual(lc.validate_lesson_file('lesson-module', path), {'ok': True})


class PreSchemaTests(unittest.TestCase):
    def test_text_over_the_cap_is_too_large_before_parsing(self):
        text = '{' + ' ' * lc.MAX_BYTES  # one byte over the cap, and not valid JSON
        result = lc.validate_lesson_text('packet', text)
        self.assertEqual(result['reason'], 'too_large')
        self.assertEqual(result['errors'], [{'pointer': '', 'message': 'The document is larger than the 5 MB limit.'}])

    def test_text_at_the_cap_is_parsed(self):
        text = '{' + ' ' * (lc.MAX_BYTES - 1)
        self.assertEqual(lc.validate_lesson_text('packet', text)['reason'], 'invalid')

    def test_the_cap_counts_bytes_not_characters(self):
        text = '"' + 'é' * (lc.MAX_BYTES // 2) + '"'  # two bytes each, so over the cap
        self.assertEqual(lc.validate_lesson_text('packet', text)['reason'], 'too_large')

    def test_damaged_json_is_invalid(self):
        for text in ['', '{', '{"a":', '[1,]', "{'a': 1}", 'null null']:
            with self.subTest(text=text):
                result, stage = lc.validate_lesson_text_with_stage('packet', text)
                self.assertEqual(result['reason'], 'invalid')
                self.assertEqual(stage, 'parse')
                self.assertEqual(pointers(result), [''])

    def test_json_that_python_accepts_but_json_forbids_is_rejected(self):
        for text in ['{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}']:
            with self.subTest(text=text):
                self.assertEqual(lc.validate_lesson_text_with_stage('packet', text)[1], 'parse')

    def test_a_repeated_object_key_is_rejected(self):
        text = '{"schemaVersion": "1.0", "schemaVersion": "1.1"}'
        result, stage = lc.validate_lesson_text_with_stage('packet', text)
        self.assertEqual((result['reason'], stage), ('invalid', 'parse'))

    def test_a_leading_byte_order_mark_is_damaged_json(self):
        self.assertEqual(lc.validate_lesson_text('packet', '﻿{}')['reason'], 'invalid')

    def test_very_deep_nesting_is_invalid_not_a_crash(self):
        text = '[' * 100000 + ']' * 100000
        self.assertEqual(lc.validate_lesson_text('packet', text)['reason'], 'invalid')

    def test_non_text_is_invalid(self):
        for value in [None, 5, ['x'], {}]:
            with self.subTest(value=value):
                self.assertEqual(lc.validate_lesson_text('packet', value)['reason'], 'invalid')

    def test_bytes_are_accepted_as_text(self):
        data = (FIXTURES / 'valid' / 'packet-one-module.json').read_bytes()
        self.assertEqual(lc.validate_lesson_text('packet', data), {'ok': True})

    def test_unknown_kind_is_invalid(self):
        result = lc.validate_lesson_contract('curriculum', {})
        self.assertEqual(result['reason'], 'invalid')
        self.assertEqual(pointers(result), [''])
        self.assertIn('lesson-module, packet, help-record', result['errors'][0]['message'])

    def test_a_document_that_is_not_an_object_is_invalid(self):
        for value in [None, [], 'x', 3, True]:
            with self.subTest(value=value):
                result = lc.validate_lesson_contract('packet', value)
                self.assertEqual(result['reason'], 'invalid')
                self.assertEqual(pointers(result), [''])


class VersionTests(unittest.TestCase):
    def packet(self, marker):
        document = good('packet-one-module.json')
        document['schemaVersion'] = marker
        return document

    def test_other_majors_are_unsupported_and_report_only_the_marker(self):
        for marker in ['0.1', '2.0.0', '2.0', '10.4', '1000000.0', '9' * 6000 + '.0']:
            with self.subTest(marker=marker[:20]):
                result = lc.validate_lesson_contract('packet', self.packet(marker))
                self.assertEqual(result['reason'], 'unsupported_version')
                self.assertEqual(pointers(result), ['/schemaVersion'])

    def test_a_unsupported_marker_hides_every_other_problem(self):
        document = self.packet('2.0')
        document['unexpected'] = True
        del document['title']
        result = lc.validate_lesson_contract('packet', document)
        self.assertEqual(result['reason'], 'unsupported_version')
        self.assertEqual(len(result['errors']), 1)

    def test_major_one_in_a_wrong_shape_is_invalid(self):
        for marker in ['1.0.0', '1', '1.', '01.', 'v1.0', '', '1.01', '1.1234567', ' 1.0', '1.0\n']:
            with self.subTest(marker=marker):
                result = lc.validate_lesson_contract('packet', self.packet(marker))
                self.assertEqual(result['reason'], 'invalid', marker)

    def test_a_marker_that_is_not_a_string_is_invalid(self):
        for marker in [1, 1.0, None, True, ['1.0']]:
            with self.subTest(marker=marker):
                self.assertEqual(lc.validate_lesson_contract('packet', self.packet(marker))['reason'], 'invalid')

    def test_arabic_indic_digits_are_not_a_major_number(self):
        result = lc.validate_lesson_contract('packet', self.packet('٢.0'))
        self.assertEqual(result['reason'], 'invalid')

    def test_good_markers(self):
        for marker in ['1.0', '1.1', '1.999999']:
            with self.subTest(marker=marker):
                self.assertEqual(lc.validate_lesson_contract('packet', self.packet(marker)), {'ok': True})
        self.assertEqual(lc.validate_lesson_contract('packet', self.packet('1.1000000'))['reason'], 'invalid')


class FileTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix='schola-lesson-file-'))
        self.addCleanup(shutil.rmtree, self.folder, True)

    def test_missing_file_is_unreadable_with_the_error_name_and_no_path(self):
        result = lc.validate_lesson_file('packet', self.folder / 'nope.json')
        self.assertEqual(result['reason'], 'unreadable')
        self.assertEqual(result['errors'], [{'pointer': '', 'message': 'The file could not be read (ENOENT).'}])
        self.assertNotIn(str(self.folder), json.dumps(result))

    def test_a_directory_is_unreadable(self):
        result = lc.validate_lesson_file('packet', self.folder)
        self.assertEqual(result['reason'], 'unreadable')
        self.assertIn('(EISDIR)', result['errors'][0]['message'])

    @unittest.skipIf(os.name == 'nt' or (hasattr(os, 'geteuid') and os.geteuid() == 0), 'permissions do not apply')
    def test_a_file_without_read_permission_is_unreadable(self):
        path = self.folder / 'locked.json'
        path.write_text('{}', encoding='utf-8')
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        result = lc.validate_lesson_file('packet', path)
        self.assertEqual(result['reason'], 'unreadable')
        self.assertIn('(EACCES)', result['errors'][0]['message'])

    def test_a_large_file_is_too_large(self):
        path = self.folder / 'big.json'
        with open(path, 'wb') as handle:
            handle.write(b' ' * (lc.MAX_BYTES + 1))
        self.assertEqual(lc.validate_lesson_file('packet', path)['reason'], 'too_large')

    def test_a_damaged_file_stays_as_it_was(self):
        path = self.folder / 'damaged.json'
        path.write_bytes(b'{"schemaVersion": ')
        os.utime(path, (1_577_934_245, 1_577_934_245))
        before = (path.read_bytes(), path.stat().st_mtime_ns)
        self.assertEqual(lc.validate_lesson_file('packet', path)['reason'], 'invalid')
        self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ['damaged.json'])

    def test_a_file_with_bad_utf8_is_read_not_crashed(self):
        path = self.folder / 'bad.json'
        path.write_bytes(b'{"title": "\xff\xfe"}')
        self.assertEqual(lc.validate_lesson_file('packet', path)['reason'], 'invalid')

    def test_bytes_that_are_not_utf8_are_invalid_and_never_repaired(self):
        good_bytes = (FIXTURES / 'valid' / 'lesson-module-minimal.json').read_bytes()
        broken = good_bytes.replace(b'"A minimal lesson module"', b'"A minimal \xff lesson module"')
        self.assertNotEqual(broken, good_bytes)
        self.assertEqual(lc.validate_lesson_text('lesson-module', good_bytes), {'ok': True})
        result = lc.validate_lesson_text('lesson-module', broken)
        self.assertEqual(result['reason'], 'invalid')
        self.assertIn('UTF-8', result['errors'][0]['message'])
        path = self.folder / 'bad-title.json'
        path.write_bytes(broken)
        self.assertEqual(lc.validate_lesson_file('lesson-module', path)['reason'], 'invalid')

    def test_a_string_path_and_a_path_object_both_work(self):
        path = FIXTURES / 'valid' / 'packet-one-module.json'
        self.assertEqual(lc.validate_lesson_file('packet', str(path)), {'ok': True})
        self.assertEqual(lc.validate_lesson_file('packet', path), {'ok': True})


class SemanticTests(unittest.TestCase):
    def module(self):
        return good('lesson-module-minimal.json')

    def test_duplicate_block_task_and_check_ids(self):
        document = good('lesson-module-full.json')
        document['blocks'][1]['id'] = document['blocks'][0]['id']
        document['tasks'].append(copy.deepcopy(document['tasks'][0]))
        document['checks'].append(copy.deepcopy(document['checks'][0]))
        result = lc.validate_lesson_contract('lesson-module', document)
        self.assertEqual(result['reason'], 'invalid')
        self.assertEqual(
            pointers(result),
            sorted(['/blocks/1/id', f"/tasks/{len(document['tasks']) - 1}/id", f"/checks/{len(document['checks']) - 1}/id"]),
        )

    def test_dangling_check_reference(self):
        document = good('lesson-module-full.json')
        reference = next(block for block in document['blocks'] if block['type'] == 'check-reference')
        reference['checkId'] = 'no-such-check'
        index = document['blocks'].index(reference)
        result, stage = lc.validate_lesson_text_with_stage('lesson-module', json.dumps(document))
        self.assertEqual(stage, 'semantic')
        self.assertEqual(pointers(result), [f'/blocks/{index}/checkId'])

    def test_self_prerequisite(self):
        document = self.module()
        document['prerequisites'] = ['other-module', document['id']]
        self.assertEqual(pointers(lc.validate_lesson_contract('lesson-module', document)), ['/prerequisites/1'])

    def test_hint_ladder_check_is_a_backstop_for_the_schema(self):
        document = self.module()
        document['tasks'][0]['hints'].reverse()
        self.assertEqual(lc.validate_lesson_contract('lesson-module', document)['reason'], 'invalid')
        self.assertEqual(lc.semantic_errors('lesson-module', document)[0]['pointer'], '/tasks/0/hints')
        self.assertEqual(lc.semantic_errors('lesson-module', self.module()), [])

    def test_duplicate_module_ids_in_a_packet(self):
        document = good('packet-multi-module.json')
        document['modules'][1]['id'] = document['modules'][0]['id']
        self.assertEqual(pointers(lc.validate_lesson_contract('packet', document)), ['/modules/1/id'])

    def test_help_record_days(self):
        document = good('help-record-nudge-null-attempt.json')
        cases = {
            '2024-02-29T10:00:00Z': True,
            '2000-02-29T10:00:00Z': True,
            '2023-02-29T10:00:00Z': False,
            '2100-02-29T10:00:00Z': False,
            '2024-04-31T10:00:00Z': False,
            '2024-06-31T10:00:00Z': False,
            '2024-09-31T10:00:00Z': False,
            '2024-11-31T10:00:00Z': False,
            '2024-12-31T23:59:59.123456789+05:30': True,
            '2024-01-32T10:00:00Z': False,
        }
        for stamp, valid in cases.items():
            with self.subTest(stamp=stamp):
                document['timestamp'] = stamp
                result = lc.validate_lesson_contract('help-record', document)
                self.assertEqual(result['ok'], valid, result)
                if not valid:
                    self.assertEqual(pointers(result), ['/timestamp'])

    def test_error_cap_adds_a_marker(self):
        document = self.module()
        document['blocks'] = [{'type': 'text', 'id': 'same', 'body': 'x'} for _ in range(200)]
        result = lc.validate_lesson_contract('lesson-module', document)
        self.assertEqual(len(result['errors']), 101)
        self.assertEqual(result['errors'][-1], {'pointer': '', 'message': '99 more errors omitted.'})
        self.assertEqual(result['errors'][0]['pointer'], '/blocks/1/id')

    def test_exactly_one_hundred_errors_have_no_marker(self):
        document = self.module()
        document['blocks'] = [{'type': 'text', 'id': 'same', 'body': 'x'} for _ in range(101)]
        result = lc.validate_lesson_contract('lesson-module', document)
        self.assertEqual(len(result['errors']), 100)
        self.assertNotIn('omitted', result['errors'][-1]['message'])

    def test_schema_error_cap(self):
        document = good('packet-one-module.json')
        document['modules'] = [{'id': 'm'} for _ in range(150)]
        result = lc.validate_lesson_contract('packet', document)
        self.assertEqual(len(result['errors']), 101)
        self.assertEqual(result['errors'][-1]['message'], '50 more errors omitted.')

    def test_documents_are_never_changed(self):
        names = [('valid', entry['file']) for entry in load_manifest() if entry['stage'] != 'parse']
        for entry in load_manifest():
            if entry['stage'] == 'parse':
                continue
            document = json.loads((FIXTURES / entry['file']).read_text(encoding='utf-8'))
            snapshot = copy.deepcopy(document)
            lc.validate_lesson_contract(entry['kind'], document)
            self.assertEqual(document, snapshot, entry['name'])
        self.assertTrue(names)

    def test_packet_from_module_builds_a_new_object(self):
        module = good('lesson-module-full.json')
        snapshot = copy.deepcopy(module)
        packet = lc.packet_from_module(module)
        self.assertEqual(module, snapshot)
        self.assertEqual(list(packet), ['schemaVersion', 'id', 'version', 'title', 'modules'])
        self.assertEqual(packet['modules'], [{'id': module['id'], 'version': module['version']}])
        self.assertEqual(lc.validate_lesson_contract('packet', packet), {'ok': True})


class SchemaDetailTests(unittest.TestCase):
    """Cases where Python and ECMAScript rules differ, checked on the real schemas."""

    def test_a_title_of_only_unicode_spaces_is_invalid(self):
        for title in [' ', ' ', '　', '﻿', '​', ' \t\n', ' ']:
            with self.subTest(title=repr(title)):
                document = good('packet-one-module.json')
                document['title'] = title
                self.assertEqual(pointers(lc.validate_lesson_contract('packet', document)), ['/title'])

    def test_a_title_with_one_visible_character_is_valid(self):
        document = good('packet-one-module.json')
        document['title'] = ' x '
        self.assertEqual(lc.validate_lesson_contract('packet', document), {'ok': True})

    def test_a_trailing_newline_does_not_pass_an_anchored_pattern(self):
        document = good('packet-one-module.json')
        document['id'] = document['id'] + '\n'
        self.assertEqual(pointers(lc.validate_lesson_contract('packet', document)), ['/id'])

    def test_digits_are_ascii_only(self):
        document = good('help-record-nudge-null-attempt.json')
        document['timestamp'] = '٢٠٢٤-01-01T00:00:00Z'
        self.assertEqual(pointers(lc.validate_lesson_contract('help-record', document)), ['/timestamp'])

    def test_length_counts_code_points(self):
        document = good('packet-one-module.json')
        document['title'] = '\U0001F600' * 200
        self.assertEqual(lc.validate_lesson_contract('packet', document), {'ok': True})
        document['title'] = '\U0001F600' * 201
        self.assertEqual(pointers(lc.validate_lesson_contract('packet', document)), ['/title'])

    def test_booleans_are_not_integers(self):
        document = good('lesson-module-full.json')
        document['estimatedMinutes'] = True
        self.assertEqual(pointers(lc.validate_lesson_contract('lesson-module', document)), ['/estimatedMinutes'])
        document['estimatedMinutes'] = 5.0
        self.assertEqual(lc.validate_lesson_contract('lesson-module', document), {'ok': True})
        document['estimatedMinutes'] = 5.5
        self.assertEqual(pointers(lc.validate_lesson_contract('lesson-module', document)), ['/estimatedMinutes'])
        document['estimatedMinutes'] = 0
        self.assertEqual(pointers(lc.validate_lesson_contract('lesson-module', document)), ['/estimatedMinutes'])

    def test_a_required_field_that_is_null_is_not_missing(self):
        document = good('help-record-nudge-null-attempt.json')
        self.assertIsNone(document['attemptId'])
        self.assertEqual(lc.validate_lesson_contract('help-record', document), {'ok': True})
        del document['attemptId']
        self.assertEqual(pointers(lc.validate_lesson_contract('help-record', document)), ['/attemptId'])

    def test_deep_frozen_input_is_not_changed(self):
        class Frozen(dict):
            def __setitem__(self, *args):
                raise AssertionError('input was changed')
            __delitem__ = pop = popitem = clear = update = setdefault = __setitem__

        class FrozenList(list):
            def __setitem__(self, *args):
                raise AssertionError('input was changed')
            append = extend = insert = pop = remove = clear = sort = reverse = __delitem__ = __setitem__

        def freeze(value):
            if isinstance(value, dict):
                return Frozen({k: freeze(v) for k, v in value.items()})
            if isinstance(value, list):
                return FrozenList(freeze(v) for v in value)
            return value

        for entry in load_manifest():
            if entry['stage'] == 'parse':
                continue
            document = freeze(json.loads((FIXTURES / entry['file']).read_text(encoding='utf-8')))
            with self.subTest(case=entry['name']):
                self.assertEqual(lc.validate_lesson_contract(entry['kind'], document)['ok'], entry['expect'] == 'valid')


def registry(schema, *more):
    base = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'urn:test:main'}
    return lc.SchemaRegistry([dict(base, **schema), *more])


def run(schema, instance, *more):
    return registry(schema, *more).validate('urn:test:main', instance)


class KeywordTests(unittest.TestCase):
    def passes(self, schema, instance):
        self.assertEqual(run(schema, instance), [], (schema, instance))

    def fails(self, schema, instance, where=''):
        found = run(schema, instance)
        self.assertTrue(found, (schema, instance))
        self.assertIn(where, [pointer for pointer, _ in found])

    def test_type(self):
        samples = {'string': 'a', 'number': 1.5, 'integer': 2, 'boolean': False, 'null': None, 'object': {}, 'array': []}
        for name, sample in samples.items():
            for other, value in samples.items():
                accepted = name == other or (name == 'number' and other == 'integer')
                with self.subTest(type=name, value=other):
                    (self.passes if accepted else self.fails)({'type': name}, value)
        self.passes({'type': ['string', 'null']}, None)
        self.fails({'type': ['string', 'null']}, 3)
        self.passes({'type': 'integer'}, 3.0)
        self.fails({'type': 'number'}, True)
        self.fails({'type': 'integer'}, True)

    def test_enum_and_const_tell_booleans_from_numbers(self):
        self.passes({'enum': [1, 'a', None]}, 1.0)
        self.fails({'enum': [1, 2]}, True)
        self.fails({'enum': [0]}, False)
        self.passes({'enum': [{'a': [1, 2]}]}, {'a': [1.0, 2]})
        self.fails({'enum': [{'a': 1}]}, {'a': True})
        self.passes({'const': True}, True)
        self.fails({'const': 1}, True)
        self.fails({'const': 'x'}, 'y')

    def test_pattern_uses_search_and_ecmascript_classes(self):
        self.passes({'pattern': 'ab'}, 'xxabxx')
        self.fails({'pattern': '^ab$'}, 'ab\n')
        self.fails({'pattern': r'^\d+$'}, '٢')
        self.passes({'pattern': r'^\d+$'}, '123')
        self.fails({'pattern': r'^[^\s]+$'}, 'a b')
        self.passes({'pattern': r'^.$'}, 'x')
        self.fails({'pattern': r'^.$'}, ' ')
        self.passes({'pattern': 'a'}, 5)  # a pattern ignores values that are not strings

    def test_lengths_and_bounds(self):
        self.passes({'minLength': 1, 'maxLength': 2}, '\U0001F600')
        self.fails({'maxLength': 1}, 'ab')
        self.fails({'minLength': 2}, 'a')
        self.passes({'minimum': 0, 'maximum': 3}, 3)
        self.fails({'minimum': 0}, -1)
        self.fails({'maximum': 3}, 3.5)
        self.passes({'minimum': 0}, 'text')
        self.passes({'minimum': 0}, True)
        self.passes({'exclusiveMinimum': 0}, 1)
        self.fails({'exclusiveMinimum': 0}, 0)
        self.fails({'exclusiveMaximum': 5}, 5)

    def test_object_keywords(self):
        self.fails({'required': ['a']}, {}, '/a')
        self.passes({'required': ['a']}, {'a': None})
        self.fails({'properties': {'a': {'type': 'string'}}}, {'a': 1}, '/a')
        self.fails({'properties': {'a/b': {'type': 'string'}}}, {'a/b': 1}, '/a~1b')
        self.fails({'properties': {'a~b': {'type': 'string'}}}, {'a~b': 1}, '/a~0b')
        self.fails({'additionalProperties': False}, {'x': 1})
        self.passes({'properties': {'x': {}}, 'additionalProperties': False}, {'x': 1})
        self.fails({'additionalProperties': {'type': 'integer'}}, {'x': 'no'}, '/x')
        self.fails({'maxProperties': 1}, {'a': 1, 'b': 2})
        self.fails({'minProperties': 1}, {})
        self.fails({'propertyNames': {'pattern': '^[a-z]+$'}}, {'A': 1})
        self.passes({'propertyNames': {'pattern': '^[a-z]+$'}}, {'a': 1})
        self.passes({'required': ['a']}, [])  # an object keyword ignores other types
        self.fails({'properties': {'a': False}}, {'a': 1}, '/a')
        self.passes({'properties': {'a': True}}, {'a': 1})

    def test_array_keywords(self):
        self.fails({'minItems': 2}, [1])
        self.fails({'maxItems': 1}, [1, 2])
        self.fails({'items': {'type': 'integer'}}, [1, 'x'], '/1')
        self.fails({'uniqueItems': True}, [1, 2, 1])
        self.fails({'uniqueItems': True}, [{'a': [1]}, {'a': [1.0]}])
        self.passes({'uniqueItems': True}, [1, True, 0, False, '1', None])
        self.passes({'uniqueItems': True}, [{'a': 1}, {'a': True}])
        self.passes({'uniqueItems': False}, [1, 1])
        schema = {'prefixItems': [{'const': 'a'}, {'const': 'b'}], 'items': False}
        self.passes(schema, ['a', 'b'])
        self.passes(schema, ['a'])
        self.fails(schema, ['a', 'x'], '/1')
        self.fails(schema, ['a', 'b', 'c'])
        self.passes({'prefixItems': [{'const': 'a'}], 'items': {'type': 'integer'}}, ['a', 3])
        self.fails({'prefixItems': [{'const': 'a'}], 'items': {'type': 'integer'}}, ['a', 'x'], '/1')

    def test_combinators(self):
        self.passes({'oneOf': [{'type': 'string'}, {'type': 'null'}]}, None)
        self.fails({'oneOf': [{'type': 'string'}, {'type': 'number'}]}, True)
        self.fails({'oneOf': [{'type': 'integer'}, {'type': 'number'}]}, 3)
        self.passes({'anyOf': [{'type': 'integer'}, {'type': 'number'}]}, 3)
        self.fails({'anyOf': [{'type': 'string'}, {'type': 'null'}]}, 3)
        self.fails({'allOf': [{'type': 'integer'}, {'minimum': 5}]}, 3)
        self.passes({'allOf': [{'type': 'integer'}, {'minimum': 5}]}, 6)
        self.fails({'not': {'type': 'string'}}, 'x')
        self.passes({'not': {'type': 'string'}}, 3)
        self.passes({'not': {'enum': ['__proto__']}}, 'ok')

    def test_if_then_else(self):
        schema = {
            'if': {'properties': {'k': {'const': 'a'}}, 'required': ['k']},
            'then': {'required': ['x']},
            'else': {'properties': {'x': False}},
        }
        self.passes(schema, {'k': 'a', 'x': 1})
        self.fails(schema, {'k': 'a'}, '/x')
        self.passes(schema, {'k': 'b'})
        self.fails(schema, {'k': 'b', 'x': 1}, '/x')
        self.passes({'then': False}, 1)  # then without if does nothing
        self.passes({'if': {'type': 'string'}, 'then': {'minLength': 1}}, 5)
        self.fails({'if': {'type': 'string'}, 'then': {'minLength': 1}}, '')

    def test_refs(self):
        schema = {'$defs': {'n': {'type': 'integer'}}, 'properties': {'a': {'$ref': '#/$defs/n'}}}
        self.passes(schema, {'a': 1})
        self.fails(schema, {'a': 'x'}, '/a')
        other = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'urn:test:other', '$defs': {'s': {'type': 'string', '$ref': '#/$defs/t'}, 't': {'minLength': 2}}}
        cross = {'properties': {'a': {'$ref': 'urn:test:other#/$defs/s'}}}
        self.assertEqual(run(cross, {'a': 'ab'}, other), [])
        self.assertTrue(run(cross, {'a': 'a'}, other))
        self.assertTrue(run(cross, {'a': 5}, other))
        self.assertEqual(run({'$ref': 'urn:test:other'}, 1, other), [])
        sibling = {'$ref': '#/$defs/n', '$defs': {'n': {'type': 'integer'}}, 'minimum': 10}
        self.fails(sibling, 5)
        self.fails(sibling, 'x')
        self.passes(sibling, 11)
        escaped = {'$defs': {'a/b': {'type': 'integer'}, 'c~d': {'type': 'integer'}, 'e f': {'type': 'integer'}}}
        for pointer in ['#/$defs/a~1b', '#/$defs/c~0d', '#/$defs/e%20f']:
            self.fails(dict(escaped, **{'$ref': pointer}), 'x')

    def test_unknown_schema_id_is_an_error(self):
        with self.assertRaises(KeyError):
            registry({}).validate('urn:test:missing', 1)


class UnsupportedFeatureTests(unittest.TestCase):
    def test_every_contract_schema_for_lessons_loads(self):
        reg = lc.contract_registry()
        for kind in lc.LESSON_CONTRACT_KINDS:
            self.assertIsNotNone(reg.validate(f'urn:schola:contract:{kind}:v1', {}))

    def test_an_unsupported_keyword_raises_instead_of_passing(self):
        keywords = {
            'format': 'email',
            'dependentRequired': {'a': ['b']},
            'dependentSchemas': {'a': {}},
            'patternProperties': {'^a': {}},
            'contains': {},
            'multipleOf': 2,
            'unevaluatedProperties': False,
            'unevaluatedItems': False,
            'minContains': 1,
            '$dynamicRef': '#x',
            '$anchor': 'x',
            'contentEncoding': 'base64',
            'madeUpKeyword': True,
        }
        for keyword, value in keywords.items():
            with self.subTest(keyword=keyword):
                with self.assertRaises(lc.UnsupportedKeywordError) as caught:
                    registry({keyword: value})
                self.assertIn(keyword, str(caught.exception))

    def test_an_unsupported_keyword_in_a_nested_branch_still_raises(self):
        nested = [
            {'properties': {'a': {'items': {'oneOf': [{'type': 'string'}, {'format': 'uri'}]}}}},
            {'$defs': {'x': {'allOf': [{'not': {'if': {'format': 'x'}}}]}}},
            {'additionalProperties': {'propertyNames': {'format': 'x'}}},
            {'prefixItems': [{'then': {'format': 'x'}}]},
        ]
        for schema in nested:
            with self.subTest(schema=schema):
                with self.assertRaises(lc.UnsupportedKeywordError):
                    registry(schema)

    def test_annotation_keywords_are_allowed(self):
        registry({'title': 'x', 'description': 'y', '$comment': 'z', 'default': 1, 'examples': [1], 'deprecated': True})

    def test_a_keyword_name_inside_data_is_not_a_keyword(self):
        reg = registry({'properties': {'format': {'type': 'string'}}, 'enum': [{'format': 'x'}]})
        self.assertEqual(reg.validate('urn:test:main', {'format': 'x'}), [])

    def test_bad_schemas_raise(self):
        bad = [
            {'$ref': 'urn:test:nowhere'},
            {'$ref': '#/$defs/missing'},
            {'$ref': '#frag'},
            {'type': 'madeup'},
            {'required': 'a'},
            {'pattern': '['},
            {'pattern': r'\bword\b'},
            {'pattern': r'(?<name>x)'},
            {'pattern': r'\1'},
            {'properties': []},
            {'minimum': 'x'},
            {'$schema': 'http://json-schema.org/draft-07/schema#'},
            {'properties': {'a': {'$id': 'urn:test:inner'}}},
        ]
        for schema in bad:
            with self.subTest(schema=schema):
                with self.assertRaises(lc.SchemaError):
                    registry(schema)

    def test_unsupported_keyword_error_is_a_schema_error(self):
        self.assertTrue(issubclass(lc.UnsupportedKeywordError, lc.SchemaError))

    def test_duplicate_or_missing_ids_raise(self):
        with self.assertRaises(lc.SchemaError):
            lc.SchemaRegistry([{'$id': 'urn:test:a'}, {'$id': 'urn:test:a'}])
        with self.assertRaises(lc.SchemaError):
            lc.SchemaRegistry([{'type': 'string'}])

    def test_a_contract_with_an_unsupported_keyword_cannot_be_loaded_from_a_folder(self):
        folder = Path(tempfile.mkdtemp(prefix='schola-lesson-schemas-'))
        self.addCleanup(shutil.rmtree, folder, True)
        for kind in lc.LESSON_CONTRACT_KINDS + ('lesson-common',):
            name = f'{"packet" if kind == "packet" else kind}.v1.schema.json'
            source = ROOT / 'contracts' / (f'{kind}.v1.schema.json')
            shutil.copy(source, folder / name)
        schema_path = folder / 'packet.v1.schema.json'
        schema = json.loads(schema_path.read_text(encoding='utf-8'))
        schema['properties']['title']['format'] = 'x'
        schema_path.write_text(json.dumps(schema), encoding='utf-8')
        with self.assertRaises(lc.UnsupportedKeywordError):
            lc.load_contract_registry(folder)

    def contract_folder(self):
        folder = Path(tempfile.mkdtemp(prefix='schola-lesson-schemas-'))
        self.addCleanup(shutil.rmtree, folder, True)
        for source in (ROOT / 'contracts').glob('*.schema.json'):
            shutil.copy(source, folder / source.name)
        return folder

    def test_a_schema_file_that_cannot_be_read_stops_loading(self):
        folder = self.contract_folder()
        (folder / 'zz-broken.schema.json').write_text('{"$id": ', encoding='utf-8')
        with self.assertRaises(lc.SchemaError):
            lc.load_contract_registry(folder)

    def test_a_schema_file_without_an_id_stops_loading(self):
        folder = self.contract_folder()
        (folder / 'zz-noid.schema.json').write_text('{"type": "object"}', encoding='utf-8')
        with self.assertRaises(lc.SchemaError):
            lc.load_contract_registry(folder)
        (folder / 'zz-noid.schema.json').write_text('[1]', encoding='utf-8')
        with self.assertRaises(lc.SchemaError):
            lc.load_contract_registry(folder)

    def test_two_schema_files_with_one_id_stop_loading(self):
        folder = self.contract_folder()
        shutil.copy(folder / 'packet.v1.schema.json', folder / 'zz-copy.schema.json')
        with self.assertRaises(lc.SchemaError) as caught:
            lc.load_contract_registry(folder)
        self.assertIn('more than one', str(caught.exception))

    def test_the_real_contract_folder_still_loads(self):
        self.assertIsNotNone(lc.load_contract_registry(self.contract_folder()))


if __name__ == '__main__':
    unittest.main()
