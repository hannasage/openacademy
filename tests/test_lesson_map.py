import copy
import json
import random
import re
import unittest
from pathlib import Path

import lesson_map
from lesson_map import (
    LessonMapError,
    build_reverse_index,
    fallback_id,
    is_valid_lesson_id,
    map_curriculum,
    reverse_lookup,
)

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests' / 'fixtures' / 'contracts' / 'valid'
PATTERN = re.compile(r'[a-z0-9][a-z0-9-]{0,59}')
RESERVED = ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def course(curriculum_id, module_ids, tasks=2):
    return {
        'id': curriculum_id,
        'modules': [{'id': m, 'tasks': ['t%d' % i for i in range(tasks)]} for m in module_ids],
    }


def lesson_ids(result):
    return [m['lessonId'] for m in result['modules']]


class SoccerFixtureTests(unittest.TestCase):
    def test_soccer_curriculum_maps_to_the_fixture_ids(self):
        curriculum = load(ROOT / 'curriculum.json')
        result = map_curriculum(curriculum)
        fixtures = [load(p) for p in sorted(FIXTURES.glob('lesson-module-soccer-m*.json'))]
        self.assertEqual(len(fixtures), 13)
        self.assertEqual(lesson_ids(result), [f['id'] for f in fixtures])
        for mapped, fixture in zip(result['modules'], fixtures):
            self.assertEqual(mapped['taskIds'], [t['id'] for t in fixture['tasks']])

    def test_soccer_ids_match_the_packet(self):
        packet = load(FIXTURES / 'packet-soccer-ml.json')
        result = map_curriculum(load(ROOT / 'curriculum.json'))
        self.assertEqual(lesson_ids(result), [m['id'] for m in packet['modules']])

    def test_soccer_needs_no_fallback(self):
        result = map_curriculum(load(ROOT / 'curriculum.json'))
        self.assertEqual(result['idMap']['modules']['m01'], 'soccer-ml-m01')
        self.assertEqual(result['idMap']['modules']['m13'], 'soccer-ml-m13')

    def test_legacy_ids_are_kept_beside_lesson_ids(self):
        curriculum = load(ROOT / 'curriculum.json')
        result = map_curriculum(curriculum)
        self.assertEqual([m['legacyId'] for m in result['modules']], [m['id'] for m in curriculum['modules']])
        self.assertEqual(result['curriculumId'], 'soccer-ml')


class PlainRuleTests(unittest.TestCase):
    def test_underscore_becomes_hyphen_and_case_is_lowered(self):
        result = map_curriculum(course('data-sci', ['Week_One', 'M-2']))
        self.assertEqual(lesson_ids(result), ['data-sci-week-one', 'data-sci-m-2'])

    def test_task_ids_follow_task_position(self):
        result = map_curriculum(course('abc', ['m1'], tasks=12))
        self.assertEqual(result['modules'][0]['taskIds'], ['task-%d' % i for i in range(1, 13)])

    def test_module_without_tasks_has_no_task_ids(self):
        result = map_curriculum(course('abc', ['m1'], tasks=0))
        self.assertEqual(result['modules'][0]['taskIds'], [])

    def test_task_ids_satisfy_the_pattern_for_large_modules(self):
        result = map_curriculum(course('abc', ['m1'], tasks=500))
        for task_id in result['modules'][0]['taskIds']:
            self.assertRegex(task_id, PATTERN)
        self.assertEqual(len(set(result['modules'][0]['taskIds'])), 500)

    def test_order_of_modules_is_kept(self):
        result = map_curriculum(course('abc', ['z', 'a', 'm']))
        self.assertEqual([m['legacyId'] for m in result['modules']], ['z', 'a', 'm'])


class FallbackTests(unittest.TestCase):
    NASTY = [
        'Has Space',
        'dots.in.name',
        'a/b',
        'a\\b',
        '../escape',
        'café',
        '日本語',
        'emoji-\U0001f600',
        'x' * 61,
        'x' * 500,
        'tab\there',
        'new\nline',
        'K',  # Kelvin sign, lowers to a plain k in some versions
        '\ud800',  # a lone surrogate
        '',
    ]

    def test_every_nasty_id_gets_a_valid_id(self):
        result = map_curriculum(course('abc', self.NASTY))
        for lesson_id in lesson_ids(result):
            self.assertRegex(lesson_id, PATTERN)
            self.assertTrue(is_valid_lesson_id(lesson_id))

    def test_nasty_ids_do_not_collide(self):
        ids = lesson_ids(map_curriculum(course('abc', self.NASTY)))
        self.assertEqual(len(ids), len(set(ids)))

    def test_fallback_uses_the_curriculum_prefix_and_eight_hex_digits(self):
        result = map_curriculum(course('soccer-ml', ['a b']))
        self.assertRegex(result['modules'][0]['lessonId'], r'^soccer-ml-[0-9a-f]{8}$')

    def test_fallback_value_is_pinned_across_versions(self):
        # A fixed expected value guards against a change in the hash input.
        self.assertEqual(fallback_id('soccer-ml', 'a b'), 'soccer-ml-' + self._expected_digest('soccer-ml', 'a b'))
        self.assertEqual(fallback_id('soccer-ml', 'a b'), 'soccer-ml-9ae344db')

    @staticmethod
    def _expected_digest(curriculum_id, module_id):
        import hashlib
        text = json.dumps([curriculum_id, module_id], ensure_ascii=True, separators=(',', ':'))
        return hashlib.sha256(text.encode('ascii')).hexdigest()[:8]

    def test_reserved_windows_names_are_not_valid_ids(self):
        for name in RESERVED + [n.upper() for n in RESERVED]:
            self.assertFalse(is_valid_lesson_id(name), name)
        self.assertTrue(is_valid_lesson_id('con-1'))
        self.assertTrue(is_valid_lesson_id('console'))

    def test_reserved_names_as_module_ids_give_valid_ids(self):
        for name in RESERVED:
            result = map_curriculum(course('abc', [name, name.upper()]))
            for lesson_id in lesson_ids(result):
                self.assertTrue(is_valid_lesson_id(lesson_id), lesson_id)

    def test_reserved_curriculum_names_give_valid_ids(self):
        for name in RESERVED:
            result = map_curriculum(course(name, ['con', 'nul']))
            for lesson_id in lesson_ids(result):
                self.assertTrue(is_valid_lesson_id(lesson_id), lesson_id)
            self.assertEqual(len(set(lesson_ids(result))), 2)

    def test_bad_curriculum_id_still_gives_valid_ids(self):
        for bad in ['Soccer ML', 'café', '', '---', 'x' * 200, '../..']:
            result = map_curriculum(course(bad, ['m1', 'm2']))
            ids = lesson_ids(result)
            self.assertEqual(len(set(ids)), 2, bad)
            for lesson_id in ids:
                self.assertTrue(is_valid_lesson_id(lesson_id), (bad, lesson_id))

    def test_over_length_plain_candidate_uses_the_fallback(self):
        curriculum_id = 'c' * 50
        result = map_curriculum(course(curriculum_id, ['m' * 20, 'short']))
        ids = lesson_ids(result)
        self.assertRegex(ids[0], r'^c{50}-[0-9a-f]{8}$')
        self.assertLessEqual(len(ids[0]), 60)
        self.assertEqual(ids[1], curriculum_id + '-short')

    def test_exactly_sixty_characters_stay_plain(self):
        module_id = 'm' * 9
        curriculum_id = 'c' * 50
        result = map_curriculum(course(curriculum_id, [module_id]))
        self.assertEqual(len(result['modules'][0]['lessonId']), 60)
        self.assertEqual(result['modules'][0]['lessonId'], curriculum_id + '-' + module_id)

    def test_sixty_one_characters_use_the_fallback(self):
        result = map_curriculum(course('c' * 50, ['m' * 10]))
        self.assertRegex(result['modules'][0]['lessonId'], r'^c+-[0-9a-f]{8}$')

    def test_fallback_never_exceeds_sixty_characters(self):
        for size in (1, 10, 51, 52, 60, 100, 1000):
            lesson_id = fallback_id('c' * size, 'a b')
            self.assertLessEqual(len(lesson_id), 60)
            self.assertTrue(is_valid_lesson_id(lesson_id))


class CollisionTests(unittest.TestCase):
    def test_case_and_separator_variants_do_not_collide(self):
        result = map_curriculum(course('abc', ['a_b', 'a-b', 'A_B', 'A-B', 'a_B']))
        ids = lesson_ids(result)
        self.assertEqual(len(ids), len(set(ids)))
        for lesson_id in ids:
            self.assertTrue(is_valid_lesson_id(lesson_id))

    def test_first_in_sorted_order_keeps_the_plain_id(self):
        result = map_curriculum(course('abc', ['a_b', 'a-b']))
        # 'a-b' sorts before 'a_b' by code point, so it keeps the plain id.
        self.assertEqual(result['idMap']['modules']['a-b'], 'abc-a-b')
        self.assertRegex(result['idMap']['modules']['a_b'], r'^abc-[0-9a-f]{8}$')

    def test_collision_result_does_not_depend_on_input_order(self):
        ids = ['a_b', 'a-b', 'A_B', 'A-B', 'x y', 'x.y']
        first = map_curriculum(course('abc', ids))['idMap']
        second = map_curriculum(course('abc', list(reversed(ids))))['idMap']
        self.assertEqual(first, second)

    def test_fallback_hash_that_is_taken_is_resolved_with_a_counter(self):
        base = fallback_id('abc', 'a b')
        result = map_curriculum(course('abc', ['a b']), taken=[base])
        resolved = result['modules'][0]['lessonId']
        self.assertNotEqual(resolved, base)
        self.assertEqual(resolved, fallback_id('abc', 'a b', attempt=1))
        again = map_curriculum(course('abc', ['a b']), taken=[base])
        self.assertEqual(resolved, again['modules'][0]['lessonId'])

    def test_counter_keeps_going_when_several_are_taken(self):
        taken = [fallback_id('abc', 'a b', attempt=n) for n in range(5)]
        result = map_curriculum(course('abc', ['a b']), taken=taken)
        self.assertEqual(result['modules'][0]['lessonId'], fallback_id('abc', 'a b', attempt=5))

    def test_plain_id_equal_to_a_fallback_id_is_resolved(self):
        # A module named like a hash suffix must not steal another module's fallback id.
        hashed = fallback_id('abc', 'a b')
        suffix = hashed[len('abc-'):]
        result = map_curriculum(course('abc', ['a b', suffix]))
        ids = lesson_ids(result)
        self.assertEqual(len(set(ids)), 2)

    def test_ids_used_by_other_curricula_are_avoided(self):
        # Curriculum 'a' with module 'b-c' and curriculum 'a-b' with module 'c' both want 'a-b-c'.
        first = map_curriculum(course('a', ['b-c']))
        self.assertEqual(lesson_ids(first), ['a-b-c'])
        second = map_curriculum(course('a-b', ['c']), taken=lesson_ids(first))
        self.assertNotEqual(lesson_ids(second), ['a-b-c'])
        self.assertTrue(is_valid_lesson_id(lesson_ids(second)[0]))

    def test_duplicate_legacy_module_ids_are_rejected(self):
        with self.assertRaises(LessonMapError):
            map_curriculum(course('abc', ['m1', 'm1']))

    def test_different_legacy_ids_never_collide_across_many_cases(self):
        rng = random.Random(7)
        alphabet = 'abAB09_-. /éK'
        for _ in range(200):
            names = {''.join(rng.choice(alphabet) for _ in range(rng.randint(1, 6))) for _ in range(30)}
            result = map_curriculum(course('abc', sorted(names)))
            ids = lesson_ids(result)
            self.assertEqual(len(ids), len(set(ids)), names)


class FrozenMapTests(unittest.TestCase):
    def test_frozen_entry_wins_over_the_algorithm(self):
        frozen = {'version': 1, 'curriculumId': 'abc', 'modules': {'m1': 'old-name-for-m1'}}
        result = map_curriculum(course('abc', ['m1', 'm2']), frozen=frozen)
        self.assertEqual(lesson_ids(result), ['old-name-for-m1', 'abc-m2'])

    def test_frozen_map_reproduces_the_same_ids_after_the_algorithm_changes(self):
        curriculum = course('abc', ['m1', 'a b', 'M_3'])
        first = map_curriculum(curriculum)
        original = lesson_map._plain_id
        lesson_map._plain_id = lambda *a, **k: None  # pretend the rule changed
        try:
            without_map = map_curriculum(curriculum)
            with_map = map_curriculum(curriculum, frozen=first['idMap'])
        finally:
            lesson_map._plain_id = original
        self.assertNotEqual(lesson_ids(without_map), lesson_ids(first))
        self.assertEqual(lesson_ids(with_map), lesson_ids(first))
        self.assertEqual(with_map['idMap'], first['idMap'])

    def test_map_round_trips_through_json_with_sorted_keys(self):
        first = map_curriculum(course('abc', ['m1', 'a b', 'M_3']))
        text = json.dumps(first['idMap'], sort_keys=True)
        again = map_curriculum(course('abc', ['m1', 'a b', 'M_3']), frozen=json.loads(text))
        self.assertEqual(json.dumps(again['idMap'], sort_keys=True), text)
        self.assertEqual(lesson_ids(again), lesson_ids(first))

    def test_new_modules_are_added_and_old_ids_stay(self):
        first = map_curriculum(course('abc', ['m1', 'm2']))
        second = map_curriculum(course('abc', ['m0', 'm1', 'm2', 'm3']), frozen=first['idMap'])
        self.assertEqual(second['idMap']['modules']['m1'], first['idMap']['modules']['m1'])
        self.assertEqual(second['idMap']['modules']['m2'], first['idMap']['modules']['m2'])
        self.assertEqual(lesson_ids(second), ['abc-m0', 'abc-m1', 'abc-m2', 'abc-m3'])

    def test_removed_modules_keep_their_ids_reserved(self):
        frozen = {'version': 1, 'curriculumId': 'abc', 'modules': {'gone': 'abc-new'}}
        result = map_curriculum(course('abc', ['new']), frozen=frozen)
        self.assertEqual(result['idMap']['modules']['gone'], 'abc-new')
        self.assertNotEqual(result['idMap']['modules']['new'], 'abc-new')
        self.assertTrue(is_valid_lesson_id(result['idMap']['modules']['new']))

    def test_frozen_map_for_another_curriculum_is_rejected(self):
        frozen = {'version': 1, 'curriculumId': 'other', 'modules': {}}
        with self.assertRaises(LessonMapError):
            map_curriculum(course('abc', ['m1']), frozen=frozen)

    def test_corrupt_frozen_maps_are_rejected(self):
        good = {'version': 1, 'curriculumId': 'abc', 'modules': {'m1': 'abc-m1'}}
        bad_maps = [
            [],
            {**good, 'version': 2},
            {**good, 'modules': []},
            {**good, 'modules': {'m1': 'Not Valid'}},
            {**good, 'modules': {'m1': 'con'}},
            {**good, 'modules': {'m1': 5}},
            {**good, 'modules': {'m1': 'x' * 61}},
            {**good, 'modules': {'m1': 'abc-x', 'm2': 'abc-x'}},
            {key: value for key, value in good.items() if key != 'modules'},
        ]
        for bad in bad_maps:
            with self.assertRaises(LessonMapError, msg=repr(bad)):
                map_curriculum(course('abc', ['m1']), frozen=bad)

    def test_frozen_id_taken_by_another_curriculum_is_rejected(self):
        frozen = {'version': 1, 'curriculumId': 'abc', 'modules': {'m1': 'abc-m1'}}
        with self.assertRaises(LessonMapError):
            map_curriculum(course('abc', ['m1']), frozen=frozen, taken=['abc-m1'])

    def test_empty_frozen_map_is_the_same_as_none(self):
        curriculum = course('abc', ['m1', 'a b'])
        empty = {'version': 1, 'curriculumId': 'abc', 'modules': {}}
        self.assertEqual(map_curriculum(curriculum, frozen=empty), map_curriculum(curriculum))


class ReverseLookupTests(unittest.TestCase):
    def test_lesson_id_maps_back_to_the_legacy_ids(self):
        result = map_curriculum(load(ROOT / 'curriculum.json'))
        index = build_reverse_index([result['idMap']])
        self.assertEqual(reverse_lookup(index, 'soccer-ml-m07'), ('soccer-ml', 'm07'))

    def test_fallback_ids_map_back_to_the_raw_legacy_ids(self):
        result = map_curriculum(course('abc', ['Has Space', 'x/y']))
        index = build_reverse_index([result['idMap']])
        for mapped in result['modules']:
            self.assertEqual(reverse_lookup(index, mapped['lessonId']), ('abc', mapped['legacyId']))

    def test_unknown_id_gives_none(self):
        index = build_reverse_index([map_curriculum(course('abc', ['m1']))['idMap']])
        self.assertIsNone(reverse_lookup(index, 'abc-zzz'))
        self.assertIsNone(reverse_lookup(index, 5))
        self.assertIsNone(reverse_lookup(index, None))

    def test_index_covers_many_curricula(self):
        maps = [map_curriculum(course(c, ['m1', 'm2']))['idMap'] for c in ('one', 'two')]
        index = build_reverse_index(maps)
        self.assertEqual(reverse_lookup(index, 'two-m2'), ('two', 'm2'))
        self.assertEqual(reverse_lookup(index, 'one-m1'), ('one', 'm1'))

    def test_two_maps_that_share_an_id_are_rejected(self):
        a = {'version': 1, 'curriculumId': 'a', 'modules': {'x': 'shared-id'}}
        b = {'version': 1, 'curriculumId': 'b', 'modules': {'y': 'shared-id'}}
        with self.assertRaises(LessonMapError):
            build_reverse_index([a, b])

    def test_index_does_not_alias_the_maps(self):
        result = map_curriculum(course('abc', ['m1']))
        index = build_reverse_index([result['idMap']])
        result['idMap']['modules']['m1'] = 'changed'
        self.assertEqual(reverse_lookup(index, 'abc-m1'), ('abc', 'm1'))


class PurityTests(unittest.TestCase):
    def test_input_is_never_mutated(self):
        curriculum = load(ROOT / 'curriculum.json')
        before = copy.deepcopy(curriculum)
        map_curriculum(curriculum)
        self.assertEqual(curriculum, before)
        frozen = {'version': 1, 'curriculumId': 'soccer-ml', 'modules': {'m01': 'soccer-ml-m01'}}
        frozen_before = copy.deepcopy(frozen)
        taken = ['x-y']
        taken_before = list(taken)
        map_curriculum(curriculum, frozen=frozen, taken=taken)
        self.assertEqual(curriculum, before)
        self.assertEqual(frozen, frozen_before)
        self.assertEqual(taken, taken_before)

    def test_result_does_not_alias_the_frozen_map(self):
        frozen = {'version': 1, 'curriculumId': 'abc', 'modules': {'m1': 'abc-m1'}}
        result = map_curriculum(course('abc', ['m1']), frozen=frozen)
        result['idMap']['modules']['m1'] = 'changed'
        self.assertEqual(frozen['modules']['m1'], 'abc-m1')

    def test_calls_are_idempotent(self):
        curriculum = course('abc', ['m1', 'a b', 'M_3', 'x' * 80])
        first = map_curriculum(curriculum)
        self.assertEqual(map_curriculum(curriculum), first)
        self.assertEqual(map_curriculum(curriculum, frozen=first['idMap']), first)
        third = map_curriculum(curriculum, frozen=map_curriculum(curriculum, frozen=first['idMap'])['idMap'])
        self.assertEqual(third, first)

    def test_id_map_is_plain_json_data(self):
        result = map_curriculum(course('abc', ['m1', 'a b']))
        text = json.dumps(result['idMap'], sort_keys=True)
        self.assertEqual(json.loads(text), result['idMap'])
        self.assertEqual(result['idMap']['version'], 1)
        self.assertEqual(result['idMap']['curriculumId'], 'abc')
        self.assertEqual(list(result['idMap']['modules']), sorted(result['idMap']['modules']))

    def test_bad_curriculum_shapes_are_rejected(self):
        bad = [
            None,
            [],
            {},
            {'id': 5, 'modules': []},
            {'id': 'abc'},
            {'id': 'abc', 'modules': 'nope'},
            {'id': 'abc', 'modules': ['m1']},
            {'id': 'abc', 'modules': [{'id': 5, 'tasks': []}]},
            {'id': 'abc', 'modules': [{'id': 'm1'}]},
            {'id': 'abc', 'modules': [{'id': 'm1', 'tasks': 'nope'}]},
        ]
        for value in bad:
            with self.assertRaises(LessonMapError, msg=repr(value)):
                map_curriculum(value)

    def test_empty_module_list_maps_to_nothing(self):
        result = map_curriculum({'id': 'abc', 'modules': []})
        self.assertEqual(result['modules'], [])
        self.assertEqual(result['idMap']['modules'], {})

    def test_module_has_no_file_or_clock_dependencies(self):
        source = (ROOT / 'lesson_map.py').read_text(encoding='utf-8')
        for pattern in (r'\bopen\(', r'\bimport (time|random|datetime|os|pathlib|secrets|uuid)\b', r'\bfrom (time|random|datetime|os|pathlib)\b', r'(?<![.\w])hash\('):
            self.assertIsNone(re.search(pattern, source), pattern)


class PropertyTests(unittest.TestCase):
    ALPHABET = 'abcXYZ019_-. /\\:*?"<>|éßKİ日\U0001f600\x00\t'

    def random_ids(self, rng, count):
        names = set()
        while len(names) < count:
            names.add(''.join(rng.choice(self.ALPHABET) for _ in range(rng.randint(1, 90))))
        return sorted(names)

    def test_many_generated_ids_map_to_valid_unique_stable_ids(self):
        rng = random.Random(20261031)
        for round_number in range(40):
            curriculum_id = rng.choice(['abc', 'soccer-ml', 'Bad Id', 'x' * 70, 'con'])
            names = self.random_ids(rng, 120)
            rng.shuffle(names)
            curriculum = course(curriculum_id, names, tasks=1)
            result = map_curriculum(curriculum)
            ids = lesson_ids(result)
            self.assertEqual(len(ids), len(set(ids)), round_number)
            for lesson_id in ids:
                self.assertTrue(is_valid_lesson_id(lesson_id), repr(lesson_id))
                self.assertRegex(lesson_id, PATTERN)
            # Same input again, shuffled input, and a frozen replay all agree.
            self.assertEqual(map_curriculum(curriculum), result)
            shuffled = list(names)
            rng.shuffle(shuffled)
            self.assertEqual(map_curriculum(course(curriculum_id, shuffled, tasks=1))['idMap'], result['idMap'])
            replay = map_curriculum(curriculum, frozen=json.loads(json.dumps(result['idMap'])))
            self.assertEqual(replay, result)
            index = build_reverse_index([result['idMap']])
            for mapped in result['modules']:
                self.assertEqual(reverse_lookup(index, mapped['lessonId']), (curriculum_id, mapped['legacyId']))


if __name__ == '__main__':
    unittest.main()
