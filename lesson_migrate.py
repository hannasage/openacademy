"""Derive module level progress from saved records, and keep byte copies of the originals.

The record file stays the one source of truth for every existing curriculum:
`records/<record-id>/record.json`. This module never edits or deletes it, and
it never edits or deletes `<curriculum-id>/state.json` or `curricula/*.json`.
Everything it writes goes under `_lessons/`, except `restore_originals`, which
puts saved bytes back on purpose (see below).

What `migrate` writes, in this order:

1. `snapshots/s03/<record-id>/`: a byte copy of each original file of a record
   (`record.json`, `state.json`, the `curricula/` file), then `manifest.json`
   with the digest of each copy. A snapshot is never replaced.
2. `map/<curriculum-id>.json`: the frozen table that gives each existing lesson
   an id that fits the lesson contracts (see `lesson_map`). Written once.
3. `progress/<record-id>/<lesson-id>.json`: progress for one lesson, copied
   from the record. It is derived data. It is rebuilt when the record changes.
4. `migrated.json`, last. A run that finds it changes nothing.

Before step 1 every original is checked, and nothing is written when one is
invalid. A failure while writing removes every file this run created and puts
back every derived file this run replaced.

Existing curricula get ids only. No lesson module document is built for them.

`restore_originals` is the way back, and the only code in the lesson files
allowed to overwrite an original record. It checks every snapshot first, and
then, only when the caller passes `confirm=True`, writes saved bytes over a
live file that is missing or different. It refuses a live record that is newer
than its snapshot unless `force=True`. It never deletes a file, and it is all
or nothing. Before it replaces a live file with different bytes it keeps those
bytes under `snapshots/s03-replaced/`, so work done after the migration is not
lost.

Derived progress is refreshed only when `refresh_progress` runs (the command
line `refresh`) or the migrate route runs. Saving a record does not refresh it,
so a progress file can lag behind its record until the next refresh. The record
file is always the source of truth. Run the command line only while the server
is stopped: the pin file is read, changed, and written without a lock.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import sys

import lesson_map
from lesson_store import LessonStore, LessonStoreError, _dump, _fsync_dir, rollback_incomplete
from local_store import StoreError, uuid_text

MARKER = 'migrated.json'
MARKER_VERSION = 1
SNAPSHOT_GROUP = 'snapshots/s03'
REPLACED_GROUP = 'snapshots/s03-replaced'
PROGRESS_VERSION = 1

_SNAPSHOT_NAMES = ('record.json', 'state.json', 'curriculum.json')
_CURRICULUM_ID = re.compile(r'[a-z0-9][a-z0-9-]{0,59}', re.ASCII)
_FILE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', re.ASCII)
_SHA256 = re.compile(r'[0-9a-f]{64}', re.ASCII)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _corrupt(message='A saved migration file is damaged. The file was preserved.'):
    return LessonStoreError(message, 'corrupt_file', 500)


# ---------------------------------------------------------------------------
# A small all-or-nothing writer
# ---------------------------------------------------------------------------

class _Writes:
    """Write files and folders, and undo every change if asked to."""

    def __init__(self, lessons):
        self.lessons = lessons
        self.created = []
        self.replaced = []

    def _folders(self, folder):
        missing = []
        current = Path(folder)
        while not current.exists():
            missing.append(current)
            current = current.parent
        for directory in reversed(missing):
            self.lessons._safe(directory).mkdir()
            self.created.append(directory)
            _fsync_dir(directory.parent)

    def put(self, path, data):
        path = self.lessons._safe(path)
        self._folders(path.parent)
        if path.exists():
            self.replaced.append((path, path.read_bytes()))
        else:
            self.created.append(path)
        self.lessons._atomic(path, data)

    def undo(self):
        """Put back every replaced file and remove every created one. A step that fails is reported, not hidden."""
        problems = []
        for path, old in reversed(self.replaced):
            try:
                self.lessons._atomic(path, old)
            except OSError:
                problems.append(path)
        for path in reversed(self.created):
            try:
                if path.is_dir() and not path.is_symlink():
                    path.rmdir()
                elif path.exists():
                    path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                problems.append(path)
        if problems:
            raise rollback_incomplete(self.lessons.data, problems)


# ---------------------------------------------------------------------------
# Reading the records
# ---------------------------------------------------------------------------

def _all_records(local):
    """Every record, existing or still to be created from originals, with no write."""
    existing, pending = local._migration_plan()
    on_disk = {r['recordId'] for r in existing}
    return [(r, r['recordId'] in on_disk) for r in sorted(existing + pending, key=lambda r: r['recordId'])]


def _curricula_files(local):
    """Map a curriculum id to the `curricula/` file that holds it."""
    folder = local._safe(local.root / 'curricula')
    found = {}
    if folder.exists():
        for path in sorted(folder.glob('*.json')):
            course = local._read(local._safe(path))
            if isinstance(course, dict) and isinstance(course.get('id'), str):
                found[course['id']] = path
    return found


def _originals(local, record, on_disk, curricula):
    """The live original files of one record: a list of (snapshot name, live path)."""
    course_id = record['curriculum']['id']
    files = []
    if on_disk:
        files.append(('record.json', local._path(record['recordId'])))
    if record['origin']['kind'] == 'local':
        state = local._safe(local.root / course_id / 'state.json')
        if state.is_file():
            files.append(('state.json', state))
        if course_id in curricula:
            files.append(('curriculum.json', curricula[course_id]))
    return files


# ---------------------------------------------------------------------------
# Id maps and progress
# ---------------------------------------------------------------------------

def _read_maps(lessons):
    folder = lessons._safe(lessons.root / 'map')
    maps = {}
    if folder.is_dir():
        for path in sorted(folder.glob('*.json')):
            value = lessons._read_json(path)
            try:
                curriculum_id, _ = lesson_map._read_id_map(value)
            except lesson_map.LessonMapError:
                raise _corrupt() from None
            if path.stem != curriculum_id or not _CURRICULUM_ID.fullmatch(curriculum_id):
                raise _corrupt()
            maps[curriculum_id] = value
    return maps


def _build_maps(maps, records):
    """Return (all maps, results by record id). An id already in a map never changes. A module added later is added to the map."""
    maps = dict(maps)
    mapped = {}
    for record, _ in records:
        course = record['curriculum']
        course_id = course['id']
        taken = {lid for other, m in maps.items() if other != course_id for lid in m['modules'].values()}
        try:
            result = lesson_map.map_curriculum(course, maps.get(course_id), taken)
        except lesson_map.LessonMapError as error:
            raise LessonStoreError(str(error), 'identity_collision', 409) from error
        maps[course_id] = result['idMap']
        mapped[record['recordId']] = result
    # A later record of the same curriculum may have added ids; the last map is the full one.
    return maps, mapped


def derive_progress(record, mapping):
    """The progress files for one record: {lesson id: document}. Pure; reads only its input."""
    state = record['state']
    documents = {}
    for entry in mapping['modules']:
        legacy_id, lesson_id = entry['legacyId'], entry['lessonId']
        saved = state['modules'].get(legacy_id)
        flags = saved['tasks'] if saved else [False] * len(entry['taskIds'])
        documents[lesson_id] = {
            'version': PROGRESS_VERSION,
            'revision': state['revision'],
            'moduleId': lesson_id,
            'moduleVersion': None,
            'source': {'recordId': record['recordId'], 'curriculumId': record['curriculum']['id'],
                       'legacyModuleId': legacy_id, 'stateRevision': state['revision']},
            'status': saved['status'] if saved else 'not-started',
            'tasks': {task_id: bool(flag) for task_id, flag in zip(entry['taskIds'], flags)},
            'notes': saved['notes'] if saved else '',
            'evidence': saved['evidence'] if saved else '',
            'hours': saved['hours'] if saved else 0,
            'experiments': [copy.deepcopy(e) for e in state['experiments'] if e.get('module') == legacy_id],
        }
    return documents


def _progress_path(lessons, record_id, lesson_id):
    return lessons.root / 'progress' / record_id / f'{lesson_id}.json'


def _plan_derived(lessons, records, maps):
    """Files to write for maps and progress: a list of (path, bytes) that are missing or different."""
    all_maps, mapped = _build_maps(maps, records)
    writes = []
    for course_id in sorted(all_maps):
        if all_maps[course_id] != maps.get(course_id):
            writes.append((lessons.root / 'map' / f'{course_id}.json', _dump(all_maps[course_id])))
    for record, _ in records:
        uuid_text(record['recordId'], 'recordId')
        for lesson_id, document in sorted(derive_progress(record, mapped[record['recordId']]).items()):
            path = _progress_path(lessons, record['recordId'], lesson_id)
            data = _dump(document)
            if not lessons._safe(path).exists() or lessons._read_bytes(path) != data:
                writes.append((path, data))
    return writes


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------

def _snapshot_folder(lessons, record_id):
    return lessons._safe(lessons.root / SNAPSHOT_GROUP / record_id)


def _read_manifest(lessons, record_id):
    """A validated manifest, or None when the snapshot is not finished or absent."""
    path = _snapshot_folder(lessons, record_id) / 'manifest.json'
    if not lessons._safe(path).exists():
        return None
    value = lessons._read_json(path)
    try:
        if (not isinstance(value, dict) or set(value) != {'version', 'recordId', 'curriculumId', 'createdAt', 'files'}
                or value['version'] != 1 or value['recordId'] != record_id or not isinstance(value['files'], list)
                or not _CURRICULUM_ID.fullmatch(value['curriculumId'])):
            raise ValueError()
        for item in value['files']:
            if (not isinstance(item, dict) or set(item) != {'name', 'path', 'sha256', 'size'}
                    or item['name'] not in _SNAPSHOT_NAMES or not _SHA256.fullmatch(item['sha256'])
                    or type(item['size']) is not int or not _allowed_target(item['name'], item['path'], record_id, value['curriculumId'])):
                raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise _corrupt() from None
    return value


def _allowed_target(name, path, record_id, curriculum_id):
    if not isinstance(path, str):
        return False
    if name == 'record.json':
        return path == f'records/{record_id}/record.json'
    if name == 'state.json':
        return path == f'{curriculum_id}/state.json'
    parts = path.split('/')
    return len(parts) == 2 and parts[0] == 'curricula' and _FILE_NAME.fullmatch(parts[1]) is not None and parts[1].endswith('.json')


def _verify_snapshot(lessons, manifest):
    folder = _snapshot_folder(lessons, manifest['recordId'])
    for item in manifest['files']:
        data = lessons._read_bytes(folder / item['name'])
        if _sha(data) != item['sha256'] or len(data) != item['size']:
            raise _corrupt('A saved snapshot does not match its digest. The file was preserved.')


# ---------------------------------------------------------------------------
# Public operations
# ---------------------------------------------------------------------------

def is_migrated(lessons):
    marker = lessons.root / MARKER
    return lessons._safe(marker).is_file()


def _read_marker(lessons):
    value = lessons._read_json(lessons.root / MARKER)
    if not isinstance(value, dict) or value.get('version') != MARKER_VERSION or not isinstance(value.get('records'), list):
        raise _corrupt()
    return value


def migrate(lessons, local):
    """Run the one-time migration. A second run finds the marker and changes nothing."""
    if is_migrated(lessons):
        _read_marker(lessons)
        return {'status': 'already-migrated'}
    records = _all_records(local)  # checks every original; writes nothing
    lessons.sweep_stale()
    curricula = _curricula_files(local)
    maps = _read_maps(lessons)
    stamp = lessons.clock()
    plans = []
    for record, on_disk in records:
        record_id = record['recordId']
        if _read_manifest(lessons, record_id) is not None:
            continue  # an earlier run was cut short after this snapshot; keep the first copy
        files = []
        for name, live in _originals(local, record, on_disk, curricula):
            data = local._safe(live).read_bytes()
            files.append({'name': name, 'path': str(live.relative_to(local.root)), 'sha256': _sha(data), 'size': len(data), 'data': data})
        plans.append((record_id, record['curriculum']['id'], files))
    derived = _plan_derived(lessons, records, maps)
    writes = _Writes(lessons)
    try:
        for record_id, course_id, files in plans:
            folder = _snapshot_folder(lessons, record_id)
            for item in files:
                writes.put(folder / item['name'], item['data'])
                if _sha(lessons._read_bytes(folder / item['name'])) != item['sha256']:
                    raise _corrupt('A snapshot copy did not match its source.')
            manifest = {'version': 1, 'recordId': record_id, 'curriculumId': course_id, 'createdAt': stamp,
                        'files': [{k: item[k] for k in ('name', 'path', 'sha256', 'size')} for item in files]}
            writes.put(folder / 'manifest.json', _dump(manifest))
        for path, data in derived:
            writes.put(path, data)
        writes.put(lessons.root / MARKER, _dump({
            'version': MARKER_VERSION, 'step': 's03', 'migratedAt': stamp,
            'records': [{'recordId': r['recordId'], 'curriculumId': r['curriculum']['id']} for r, _ in records]}))
    except BaseException:
        writes.undo()
        raise
    return {'status': 'migrated', 'records': len(records), 'snapshots': len(plans), 'files': len(derived)}


def refresh_progress(lessons, local):
    """Rebuild derived progress and id maps that are missing or out of date. Never touches originals."""
    if not is_migrated(lessons):
        raise LessonStoreError('Run the migration first.', 'not_migrated', 409)
    records = _all_records(local)
    derived = _plan_derived(lessons, records, _read_maps(lessons))
    writes = _Writes(lessons)
    try:
        for path, data in derived:
            writes.put(path, data)
    except BaseException:
        writes.undo()
        raise
    return {'status': 'refreshed' if derived else 'current', 'files': len(derived)}


def read_progress(lessons, record_id, lesson_id):
    """One derived progress document, or None when it has not been written."""
    uuid_text(record_id, 'recordId')
    if not lesson_map.is_valid_lesson_id(lesson_id):
        raise LessonStoreError('Invalid lesson id.', field='moduleId')
    path = _progress_path(lessons, record_id, lesson_id)
    return lessons._read_json(path) if lessons._safe(path).is_file() else None


def _revision_of(name, text):
    """The revision stored in an original file's bytes, or None when the bytes are not a record or a state."""
    try:
        value = json.loads(text.decode('utf-8'))
    except (ValueError, UnicodeError, RecursionError):
        return None
    if name == 'record.json':
        value = value.get('state') if isinstance(value, dict) else None
    elif name != 'state.json':
        return None
    revision = value.get('revision') if isinstance(value, dict) else None
    return revision if type(revision) is int else None


def restore_originals(lessons, local, confirm=False, force=False):
    """Put the snapshot bytes back over live originals that are missing or different.

    This is the one code path in the lesson code that may overwrite an original
    record file. It exists for one purpose: to undo the migration. It needs
    `confirm=True`.

    It checks every snapshot first. A snapshot that is unfinished, has a stray
    entry, or does not match its digest stops the restore before any write.
    Entries whose names start with a dot, such as `.DS_Store`, are ignored.

    A live record or state file whose revision is newer than the snapshot holds
    work saved after the migration. The restore refuses to replace it
    (`newer_than_snapshot`) unless `force=True`. The restore writes nothing then.

    It never deletes a file. Live bytes that differ are kept under
    `snapshots/s03-replaced/` first. The restore is all or nothing. When a write
    fails, it puts back every original it had replaced. If that also fails, it
    raises `partial_restore` with the files that stay replaced.
    """
    if confirm is not True:
        raise LessonStoreError('Confirm the restore before any original is replaced.', 'confirmation_required', 400, field='confirm')
    group = lessons._safe(lessons.root / SNAPSHOT_GROUP)
    manifests = []
    if group.is_dir():
        for folder in sorted(group.iterdir()):
            if folder.name.startswith('.'):
                continue
            try:
                uuid_text(folder.name, 'recordId')
            except StoreError:
                raise _corrupt('Unexpected entry in the snapshot folder. It was preserved.') from None
            manifest = _read_manifest(lessons, folder.name)
            if manifest is None:
                raise _corrupt('A snapshot is unfinished. It was preserved.')
            _verify_snapshot(lessons, manifest)
            manifests.append(manifest)
    stamp = lessons.clock()
    steps, unchanged, newer = [], 0, []
    for manifest in manifests:
        folder = _snapshot_folder(lessons, manifest['recordId'])
        for item in manifest['files']:
            live = local._safe(local.root / item['path'])
            saved = lessons._read_bytes(folder / item['name'])
            current = live.read_bytes() if live.is_file() else None
            if current == saved:
                unchanged += 1
                continue
            if current is not None and not force:
                live_revision, saved_revision = _revision_of(item['name'], current), _revision_of(item['name'], saved)
                if live_revision is not None and saved_revision is not None and live_revision > saved_revision:
                    newer.append(item['path'])
            steps.append((manifest['recordId'], item, live, saved, current))
    if newer:
        raise LessonStoreError('These files hold work saved after the migration. Nothing was restored. Export your progress first, then use the force option only if you want to replace them: ' + ', '.join(newer),
                               'newer_than_snapshot', 409, details=[{'path': path} for path in newer])
    writes = _Writes(lessons)
    done = []
    try:
        for record_id, item, live, saved, current in steps:
            if current is not None:
                kept = lessons.root / REPLACED_GROUP / record_id / f"{item['name']}.{_sha(current)[:12]}"
                if not lessons._safe(kept).exists():
                    writes.put(kept, current)
            lessons._atomic(live, saved)
            done.append((live, current, item['path']))
    except BaseException:
        still = []
        for live, current, path in reversed(done):
            try:
                if current is None:
                    live.unlink(missing_ok=True)
                else:
                    lessons._atomic(live, current)
            except OSError:
                still.append(path)
        if still:
            raise LessonStoreError('The restore failed part way and could not undo itself. These files were already restored: ' + ', '.join(still),
                                   'partial_restore', 500, details=[{'path': path} for path in still]) from None
        raise
    return {'status': 'restored' if done else 'unchanged', 'restored': [path for _, _, path in done], 'unchanged': unchanged, 'at': stamp}


def main(argv=None):
    import argparse
    from server import ROOT, initial, validate, validate_curriculum
    from local_store import LocalStore
    parser = argparse.ArgumentParser(description='Derive module progress and keep byte copies of the originals.')
    parser.add_argument('command', choices=('migrate', 'refresh', 'restore'))
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--confirm', action='store_true', help='Needed for restore.')
    parser.add_argument('--force', action='store_true', help='Restore over records saved after the migration. Their old bytes are kept.')
    args = parser.parse_args(argv)
    local = LocalStore(args.data_dir, json.loads((ROOT / 'curriculum.json').read_text()), validate_curriculum, validate, initial)
    lessons = LessonStore(args.data_dir)
    try:
        if args.command == 'migrate':
            result = migrate(lessons, local)
        elif args.command == 'refresh':
            result = refresh_progress(lessons, local)
        else:
            result = restore_originals(lessons, local, args.confirm, args.force)
    except StoreError as error:
        print(json.dumps(error.payload()), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
