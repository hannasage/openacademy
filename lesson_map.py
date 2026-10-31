"""Map existing curriculum modules to lesson module ids.

The lesson contracts name each lesson module with an id that matches
`^[a-z0-9][a-z0-9-]{0,59}$`. Existing curricula use their own module ids,
which may be upper case, may contain underscores, and are not always short
enough. This module turns each existing (curriculum id, module id) pair into
a lesson module id, and each task position into a task id.

Everything here is pure. It reads no files, no clock, and no random source.
It never changes its input. Only the standard library is used.

The id rule
-----------
1. Plain id: join the curriculum id and the module id with a hyphen, lower
   case ASCII letters only, and turn each underscore into a hyphen. Example:
   curriculum `soccer-ml`, module `m01` gives `soccer-ml-m01`. The plain id
   is used when it is a valid lesson id and no other module has it.
2. Fallback id: otherwise the id is `<prefix>-<8 hex digits>`. The prefix is
   the curriculum id cleaned to lower case letters, digits, and hyphens and
   cut to 51 characters. The digits are the start of a SHA-256 digest of the
   JSON text `[curriculumId, moduleId]` (ASCII escaped, no spaces), so two
   different legacy pairs get different digests. The result is at most 60
   characters.
3. Collisions: modules are handled in sorted order of their legacy ids (by
   code point), so the result does not depend on the order in the input. The
   first module to claim an id keeps it. If the fallback id is also taken,
   the counter is added to the digest text, as `[curriculumId, moduleId, 1]`,
   then 2, and so on, until a free id is found. Ids already used by other
   curricula are passed in as `taken` and treated as used.
4. Frozen map: the result carries an `idMap`, a plain dict that can be
   written as JSON with sorted keys. When a map is passed back in, each entry
   in it is used unchanged, whatever the rules above would say today. Entries
   for modules that left the curriculum stay in the map, so their ids are
   never given to another module.

Windows reserved device names (con, prn, aux, nul, com1 to com9, lpt1 to
lpt9) are not valid lesson ids, because an id may become a directory name.

Task ids: the task at position i (counting from 0) is `task-<i + 1>`.
"""

import hashlib
import json
import re

ID_MAP_VERSION = 1
MAX_ID_LENGTH = 60
DIGEST_LENGTH = 8
# One hyphen and the digest must fit after the prefix.
MAX_PREFIX_LENGTH = MAX_ID_LENGTH - DIGEST_LENGTH - 1

_ID_PATTERN = re.compile(r'[a-z0-9][a-z0-9-]{0,59}', re.ASCII)
_RESERVED_NAMES = frozenset(
    ['con', 'prn', 'aux', 'nul']
    + ['com%d' % n for n in range(1, 10)]
    + ['lpt%d' % n for n in range(1, 10)]
)
# Lower case only A to Z, so the result never depends on the Python version.
_ASCII_LOWER = {code: code + 32 for code in range(ord('A'), ord('Z') + 1)}
_UNSAFE_PREFIX_RUN = re.compile(r'[^a-z0-9-]+', re.ASCII)


class LessonMapError(ValueError):
    """The curriculum, the id map, or the taken ids are not usable."""


def is_valid_lesson_id(value):
    """True when value is a lesson id and not a Windows reserved name."""
    return (
        isinstance(value, str)
        and _ID_PATTERN.fullmatch(value) is not None
        and value not in _RESERVED_NAMES
    )


def _ascii_lower(text):
    return text.translate(_ASCII_LOWER)


def _plain_id(curriculum_id, module_id):
    """The plain id, or None when it is not a valid lesson id."""
    candidate = _ascii_lower(curriculum_id + '-' + module_id).replace('_', '-')
    return candidate if is_valid_lesson_id(candidate) else None


def _prefix(curriculum_id):
    cleaned = _UNSAFE_PREFIX_RUN.sub('-', _ascii_lower(curriculum_id)).strip('-')
    cleaned = cleaned[:MAX_PREFIX_LENGTH].strip('-')
    return cleaned or 'lesson'


def fallback_id(curriculum_id, module_id, attempt=0):
    """The hash based id for a legacy pair. `attempt` 0 is the first choice."""
    parts = [curriculum_id, module_id] + ([attempt] if attempt else [])
    text = json.dumps(parts, ensure_ascii=True, separators=(',', ':'))
    digest = hashlib.sha256(text.encode('ascii')).hexdigest()[:DIGEST_LENGTH]
    return _prefix(curriculum_id) + '-' + digest


def _assign(curriculum_id, module_id, used):
    plain = _plain_id(curriculum_id, module_id)
    if plain is not None and plain not in used:
        return plain
    attempt = 0
    while True:
        candidate = fallback_id(curriculum_id, module_id, attempt)
        if candidate not in used:
            return candidate
        attempt += 1


def _read_curriculum(curriculum):
    if not isinstance(curriculum, dict):
        raise LessonMapError('The curriculum must be an object.')
    curriculum_id = curriculum.get('id')
    if not isinstance(curriculum_id, str):
        raise LessonMapError('The curriculum needs a text id.')
    modules = curriculum.get('modules')
    if not isinstance(modules, list):
        raise LessonMapError('The curriculum needs a list of modules.')
    entries = []
    seen = set()
    for index, module in enumerate(modules):
        if not isinstance(module, dict) or not isinstance(module.get('id'), str):
            raise LessonMapError('Module %d needs a text id.' % (index + 1))
        if not isinstance(module.get('tasks'), list):
            raise LessonMapError('Module %d needs a list of tasks.' % (index + 1))
        if module['id'] in seen:
            raise LessonMapError('Module id %r appears twice.' % module['id'])
        seen.add(module['id'])
        entries.append((module['id'], len(module['tasks'])))
    return curriculum_id, entries


def _read_id_map(id_map):
    """Check a frozen id map and return (curriculum id, copy of its modules)."""
    if not isinstance(id_map, dict):
        raise LessonMapError('The id map must be an object.')
    version = id_map.get('version')
    if type(version) is not int or version != ID_MAP_VERSION:
        raise LessonMapError('The id map version is not supported.')
    curriculum_id = id_map.get('curriculumId')
    if not isinstance(curriculum_id, str):
        raise LessonMapError('The id map needs a curriculum id.')
    modules = id_map.get('modules')
    if not isinstance(modules, dict):
        raise LessonMapError('The id map needs a modules object.')
    values = set()
    for legacy_id, lesson_id in modules.items():
        if not isinstance(legacy_id, str) or not is_valid_lesson_id(lesson_id):
            raise LessonMapError('The id map holds an entry that is not a valid lesson id.')
        if lesson_id in values:
            raise LessonMapError('The id map gives one lesson id to two modules.')
        values.add(lesson_id)
    return curriculum_id, dict(modules)


def _read_taken(taken):
    if taken is None:
        return set()
    if isinstance(taken, (str, bytes)):
        raise LessonMapError('Taken ids must be a collection of ids.')
    return set(taken)


def map_curriculum(curriculum, frozen=None, taken=None):
    """Map one existing curriculum to lesson module ids.

    `frozen` is an id map from an earlier call (or None). `taken` holds lesson
    ids already used by other curricula. Nothing passed in is changed.

    Returns a dict:
      curriculumId: the legacy curriculum id
      modules: one entry per module, in curriculum order, with legacyId,
        lessonId, and taskIds
      idMap: the frozen id map, `{version, curriculumId, modules}`, where
        modules maps each legacy module id to its lesson id
    """
    curriculum_id, entries = _read_curriculum(curriculum)
    modules = {}
    if frozen is not None:
        frozen_curriculum_id, modules = _read_id_map(frozen)
        if frozen_curriculum_id != curriculum_id:
            raise LessonMapError('The id map belongs to another curriculum.')
    used = _read_taken(taken)
    for lesson_id in modules.values():
        if lesson_id in used:
            raise LessonMapError('The id map uses a lesson id that another curriculum has.')
        used.add(lesson_id)
    for legacy_id in sorted(legacy for legacy, _ in entries if legacy not in modules):
        lesson_id = _assign(curriculum_id, legacy_id, used)
        modules[legacy_id] = lesson_id
        used.add(lesson_id)
    return {
        'curriculumId': curriculum_id,
        'modules': [
            {
                'legacyId': legacy_id,
                'lessonId': modules[legacy_id],
                'taskIds': ['task-%d' % (n + 1) for n in range(task_count)],
            }
            for legacy_id, task_count in entries
        ],
        'idMap': {
            'version': ID_MAP_VERSION,
            'curriculumId': curriculum_id,
            'modules': {legacy_id: modules[legacy_id] for legacy_id in sorted(modules)},
        },
    }


def build_reverse_index(id_maps):
    """Build a lookup from lesson id to (curriculum id, legacy module id).

    `id_maps` is a collection of id maps, one per curriculum. Two maps that
    give the same lesson id are an error.
    """
    index = {}
    for id_map in id_maps:
        curriculum_id, modules = _read_id_map(id_map)
        for legacy_id, lesson_id in modules.items():
            if lesson_id in index:
                raise LessonMapError('Lesson id %r belongs to two modules.' % lesson_id)
            index[lesson_id] = (curriculum_id, legacy_id)
    return index


def reverse_lookup(index, lesson_id):
    """The (curriculum id, legacy module id) for a lesson id, or None."""
    if not isinstance(lesson_id, str):
        return None
    return index.get(lesson_id)
