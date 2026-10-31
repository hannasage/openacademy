"""Store imported lesson modules on disk, one write-once folder per version.

Everything lives under one new folder, `_lessons/`, inside the data folder.
A curriculum id cannot start with an underscore, so the folder never collides
with a curriculum folder, and older builds ignore it.

    _lessons/
      modules/<module-id>/<version>/module.json    the exact bytes imported
      modules/<module-id>/<version>/source.json    digest, file name, import time
      packets/<packet-id>/<version>/packet.json    the exact bytes imported
      packets/<packet-id>/<version>/source.json
      pins.json                                    {version, revision, pins}

Rules
-----
* A version is written once. Importing the same id and version again with the
  same bytes changes nothing. With different bytes it is refused.
* Importing a new version stores it and never moves a pin. The first version
  of a module that has no pin yet is pinned, because nothing is replaced.
  A pin only moves when the student confirms it with `set_pin`.
* An import checks every file first, writes into a staging folder, renames the
  finished folders into place, and writes `pins.json` last. A file that is
  damaged, too large, or in conflict stops the whole import before any write.
  A failure while writing removes everything this import created.
* A preview reads and checks. It writes nothing, not even the `_lessons/` folder.
* Every file is checked with the shared lesson schemas through
  `lesson_contract`, and no id is used as a path before that check.

Only the Python standard library is used.
"""
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import uuid

import lesson_contract
from local_store import MAX_REVISION, StoreError

LESSONS_DIRECTORY = '_lessons'
PINS_VERSION = 1
MAX_FILES = 2000
MAX_FILE_NAME = 120

_ID = re.compile(r'[a-z0-9][a-z0-9-]{0,59}', re.ASCII)
_VERSION = re.compile(r'(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})', re.ASCII)
_SHA256 = re.compile(r'[0-9a-f]{64}', re.ASCII)
_CONTROL = re.compile(r'[\x00-\x1f\x7f‪-‮⁦-⁩]')

_SHOWN = ('index', 'name', 'kind', 'id', 'version', 'title', 'sha256', 'size', 'status')
_REASON_STATUS = {'invalid': 422, 'unsupported_version': 409, 'too_large': 413, 'unreadable': 400}


class LessonStoreError(StoreError):
    """A lesson store problem. `details` holds optional per-file findings."""

    def __init__(self, message, code='invalid_lesson', status=400, field=None, details=None, **rest):
        super().__init__(message, code, status, field, **rest)
        self.details = details

    def payload(self):
        result = super().payload()
        if self.details is not None:
            result['details'] = self.details
        return result


def version_key(version):
    """A sortable key for a three part version such as 1.2.0."""
    return tuple(int(part) for part in version.split('.'))


def _dump(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n').encode()


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def clean_file_name(name):
    """A file name that is safe to show and to store: no path, no control characters."""
    if not isinstance(name, str):
        return ''
    base = name.replace('\\', '/').rsplit('/', 1)[-1]
    return _CONTROL.sub('', base).strip()[:MAX_FILE_NAME]


def _utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class LessonStore:
    def __init__(self, data_dir, clock=_utc_now):
        self.data = Path(data_dir).absolute()
        self.root = self.data / LESSONS_DIRECTORY
        self.clock = clock

    # ------------------------------------------------------------------
    # Paths and low level file work
    # ------------------------------------------------------------------

    def exists(self):
        return self.root.is_dir() and not self.root.is_symlink()

    def _safe(self, path):
        path = Path(path)
        try:
            relative = path.relative_to(self.data)
        except ValueError:
            raise LessonStoreError('Invalid data path.', 'unsafe_path') from None
        current = self.data
        for part in relative.parts:
            if part in ('.', '..'):
                raise LessonStoreError('Invalid data path.', 'unsafe_path')
            current = current / part
            if current.is_symlink():
                raise LessonStoreError('Data paths cannot be symbolic links.', 'unsafe_path', 500)
        return path

    def _read_bytes(self, path):
        return self._safe(path).read_bytes()

    def _read_json(self, path):
        data = self._read_bytes(path)
        try:
            return json.loads(data.decode('utf-8'), parse_constant=_reject_constant, object_pairs_hook=_no_repeats)
        except (ValueError, UnicodeError, RecursionError) as error:
            raise LessonStoreError('A saved lesson file is damaged. The file was preserved.', 'corrupt_file', 500) from error

    def _atomic(self, path, data):
        """Write a file with a temporary file, a flush, fsync, and a rename."""
        path = self._safe(path)
        self._safe(path.parent).mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.touchline-', suffix='.tmp', delete=False) as file:
                temp = Path(file.name)
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            self._safe(path)
            temp.replace(path)
        finally:
            if temp is not None and temp.exists():
                temp.unlink()

    def _module_dir(self, module_id, version):
        return self._safe(self.root / 'modules' / module_id / version)

    def _packet_dir(self, packet_id, version):
        return self._safe(self.root / 'packets' / packet_id / version)

    # ------------------------------------------------------------------
    # Reading what is stored
    # ------------------------------------------------------------------

    def _children(self, folder, pattern):
        folder = self._safe(folder)
        if not folder.is_dir():
            return []
        names = []
        for child in sorted(folder.iterdir()):
            if child.name.startswith('.'):
                continue
            self._safe(child)
            if not child.is_dir() or not pattern.fullmatch(child.name):
                raise LessonStoreError('Unexpected entry in the lesson folder. It was preserved.', 'corrupt_file', 500)
            names.append(child.name)
        return names

    def versions(self, module_id):
        """Stored versions of one module, oldest first."""
        if not isinstance(module_id, str) or not _ID.fullmatch(module_id):
            return []
        found = self._children(self.root / 'modules' / module_id, _VERSION)
        return sorted(found, key=version_key)

    def module_ids(self):
        return self._children(self.root / 'modules', _ID)

    def packet_ids(self):
        return self._children(self.root / 'packets', _ID)

    def _stored_bytes(self, folder, name):
        data = self._read_bytes(folder / name)
        source = self._read_json(folder / 'source.json')
        if not isinstance(source, dict) or source.get('sha256') != _digest(data):
            raise LessonStoreError('A saved lesson file does not match its digest. The file was preserved.', 'corrupt_file', 500)
        return data

    def module_bytes(self, module_id, version):
        if not self._has_module(module_id, version):
            raise LessonStoreError('That module version is not stored.', 'not_found', 404)
        return self._stored_bytes(self._module_dir(module_id, version), 'module.json')

    def _has_module(self, module_id, version):
        return (isinstance(module_id, str) and isinstance(version, str)
                and _ID.fullmatch(module_id) is not None and _VERSION.fullmatch(version) is not None
                and (self._module_dir(module_id, version) / 'module.json').is_file())

    def _has_packet(self, packet_id, version):
        return (self._packet_dir(packet_id, version) / 'packet.json').is_file()

    def source(self, kind, identifier, version):
        folder = self._module_dir(identifier, version) if kind == 'module' else self._packet_dir(identifier, version)
        return self._read_json(folder / 'source.json')

    def get_module(self, module_id, version=None):
        """The parsed document of a stored version. The pinned version when none is named."""
        if version is None:
            version = self.pins()['pins'].get(module_id)
            if version is None:
                raise LessonStoreError('That module is not pinned.', 'not_found', 404)
        return json.loads(self.module_bytes(module_id, version).decode('utf-8'))

    def get_packet(self, packet_id, version):
        if not (isinstance(packet_id, str) and isinstance(version, str) and _ID.fullmatch(packet_id)
                and _VERSION.fullmatch(version) and self._has_packet(packet_id, version)):
            raise LessonStoreError('That packet version is not stored.', 'not_found', 404)
        return json.loads(self._stored_bytes(self._packet_dir(packet_id, version), 'packet.json').decode('utf-8'))

    # ------------------------------------------------------------------
    # Pins
    # ------------------------------------------------------------------

    def pins(self):
        """The pin file, or an empty one when none was written. Never writes."""
        path = self.root / 'pins.json'
        if not self._safe(path).exists():
            return {'version': PINS_VERSION, 'revision': 0, 'pins': {}}
        value = self._read_json(path)
        try:
            if (not isinstance(value, dict) or set(value) != {'version', 'revision', 'pins'}
                    or type(value['version']) is not int or value['version'] != PINS_VERSION
                    or type(value['revision']) is not int or not 0 <= value['revision'] <= MAX_REVISION
                    or not isinstance(value['pins'], dict)):
                raise ValueError()
            for module_id, version in value['pins'].items():
                if not _ID.fullmatch(module_id) or not isinstance(version, str) or not _VERSION.fullmatch(version):
                    raise ValueError()
                if not self._has_module(module_id, version):
                    raise ValueError()
        except ValueError:
            raise LessonStoreError('The saved pin file is invalid. It was preserved.', 'corrupt_file', 500) from None
        return value

    def set_pin(self, module_id, version, confirm=False, expected_revision=None):
        """Move a pin to a stored version. Needs confirm to be exactly True."""
        if confirm is not True:
            raise LessonStoreError('Confirm the change before a pin moves.', 'confirmation_required', 400, field='confirm')
        if not self._has_module(module_id, version):
            raise LessonStoreError('That module version is not stored.', 'not_found', 404)
        current = self.pins()
        if type(expected_revision) is not int or not 0 <= expected_revision <= MAX_REVISION:
            raise LessonStoreError('Expected revision must be a nonnegative integer.', field='expectedRevision')
        if expected_revision != current['revision']:
            raise LessonStoreError('Newer changes were saved. Reload before retrying.', 'revision_conflict', 409,
                                   current_revision=current['revision'])
        if current['pins'].get(module_id) == version:
            return self.list_modules()
        if current['revision'] >= MAX_REVISION:
            raise LessonStoreError('Revision limit reached.', 'revision_limit', 409, current_revision=current['revision'])
        pins = dict(current['pins'], **{module_id: version})
        self._atomic(self.root / 'pins.json', _dump({'version': PINS_VERSION, 'revision': current['revision'] + 1, 'pins': pins}))
        return self.list_modules()

    # ------------------------------------------------------------------
    # Listing
    # ------------------------------------------------------------------

    def list_modules(self):
        """Every stored module with its pin. Read only; writes nothing.

        `newerVersionAvailable` is the newest stored version when it is newer
        than the pin, else None. It is an offer. Nothing here moves a pin.
        """
        pins = self.pins()
        modules = []
        for module_id in self.module_ids():
            stored = self.versions(module_id)
            if not stored:
                continue
            pinned = pins['pins'].get(module_id)
            shown = pinned or stored[-1]
            document = json.loads(self._stored_bytes(self._module_dir(module_id, shown), 'module.json').decode('utf-8'))
            newest = stored[-1]
            newer = newest if pinned is not None and version_key(newest) > version_key(pinned) else None
            modules.append({
                'id': module_id,
                'title': document['title'],
                'pinnedVersion': pinned,
                'versions': stored,
                'newerVersionAvailable': newer,
            })
        return {'revision': pins['revision'], 'modules': modules}

    # ------------------------------------------------------------------
    # Import
    # ------------------------------------------------------------------

    def _read_files(self, files):
        if not isinstance(files, (list, tuple)) or not 1 <= len(files) <= MAX_FILES:
            raise LessonStoreError(f'Provide between 1 and {MAX_FILES} files.', field='files')
        result = []
        for index, item in enumerate(files):
            name, data = item if isinstance(item, (list, tuple)) and len(item) == 2 else (None, None)
            if isinstance(data, str):
                try:
                    data = data.encode('utf-8')
                except UnicodeError:
                    data = None
            if not isinstance(data, (bytes, bytearray)):
                raise LessonStoreError(f'File {index + 1} needs a name and its text.', field=f'files[{index}]')
            result.append((clean_file_name(name), bytes(data)))
        return result

    def plan_import(self, files):
        """Check every file and decide what an import would do. Writes nothing.

        Returns a plan with `items`, each holding what a preview shows, and
        `problems`, a list of per-file findings. An empty list of problems means
        the import can run.
        """
        files = self._read_files(files)
        items, problems, seen = [], [], {}
        for index, (name, data) in enumerate(files):
            kind, document, result = self._classify(data)
            if not result['ok']:
                problems.append({'file': name or f'file {index + 1}', 'index': index, 'code': _problem_code(result['reason']),
                                 'status': _REASON_STATUS[result['reason']], 'reason': result['reason'],
                                 'errors': result['errors'][:20]})
                continue
            key = (kind, document['id'], document['version'])
            digest = _digest(data)
            if key in seen:
                if seen[key]['sha256'] != digest:
                    problems.append({'file': name, 'index': index, 'code': 'version_conflict', 'status': 409, 'reason': 'conflict',
                                     'errors': [{'pointer': '', 'message': 'Two files carry the same id and version with different content.'}]})
                continue
            stored = self._stored_state(kind, document['id'], document['version'], data)
            if stored == 'different':
                problems.append({'file': name, 'index': index, 'code': 'version_conflict', 'status': 409, 'reason': 'conflict',
                                 'errors': [{'pointer': '', 'message': 'This id and version are already stored with different content.'}]})
                continue
            item = {'index': index, 'name': name, 'kind': kind, 'id': document['id'], 'version': document['version'],
                    'title': document['title'], 'sha256': digest, 'size': len(data), 'status': stored, 'data': data, 'document': document}
            seen[key] = item
            items.append(item)
        if not problems:
            problems.extend(self._reference_problems(items))
        return {'items': items, 'problems': problems}

    def _classify(self, data):
        try:
            data.decode('utf-8')
        except UnicodeError:
            return 'module', None, {'ok': False, 'reason': 'invalid',
                                    'errors': [{'pointer': '', 'message': 'The file is not valid UTF-8 text.'}]}
        try:
            document = json.loads(data.decode('utf-8'), parse_constant=_reject_constant, object_pairs_hook=_no_repeats) \
                if len(data) <= lesson_contract.MAX_BYTES else None
        except (ValueError, UnicodeError, RecursionError):
            document = None
        kind = 'packet' if isinstance(document, dict) and 'modules' in document else 'lesson-module'
        result = lesson_contract.validate_lesson_text(kind, data)
        return ('packet' if kind == 'packet' else 'module'), document, result

    def _stored_state(self, kind, identifier, version, data):
        if kind == 'module':
            present = self._has_module(identifier, version)
            path = self._module_dir(identifier, version) / 'module.json'
        else:
            present = _ID.fullmatch(identifier) is not None and self._has_packet(identifier, version)
            path = self._packet_dir(identifier, version) / 'packet.json'
        if not present:
            return 'new'
        return 'already-stored' if self._read_bytes(path) == data else 'different'

    def _reference_problems(self, items):
        incoming = {(i['id'], i['version']) for i in items if i['kind'] == 'module'}
        problems = []
        for item in items:
            if item['kind'] != 'packet':
                continue
            for position, ref in enumerate(item['document']['modules']):
                if (ref['id'], ref['version']) not in incoming and not self._has_module(ref['id'], ref['version']):
                    problems.append({'file': item['name'], 'index': item['index'], 'code': 'missing_module', 'status': 400, 'reason': 'invalid',
                                     'errors': [{'pointer': f'/modules/{position}', 'message': 'The packet names a module version that is not in this import or in the store.'}]})
        return problems

    def preview_import(self, files):
        """What an import would do. Reads and checks; writes nothing at all."""
        plan = self.plan_import(files)
        pins = self.pins()
        pinned = dict(pins['pins'])
        entries = []
        for item in plan['items']:
            entry = {k: item[k] for k in _SHOWN}
            if item['kind'] == 'module':
                current = pinned.get(item['id'])
                if current is None:
                    entry['pin'] = 'will-pin'
                    pinned[item['id']] = item['version']
                elif version_key(item['version']) > version_key(current):
                    entry['pin'] = 'newer-than-pin'
                else:
                    entry['pin'] = 'kept'
                entry['pinnedVersion'] = current
            else:
                entry['modules'] = copy.deepcopy(item['document']['modules'])
            entries.append(entry)
        return {'importable': not plan['problems'], 'files': entries, 'problems': plan['problems']}

    def import_files(self, files):
        """Store every file or none. Returns the same shape as a preview, with the new module list."""
        plan = self.plan_import(files)
        if plan['problems']:
            first = plan['problems'][0]
            raise LessonStoreError(f"{first['file']}: {first['errors'][0]['message']}", first['code'], first['status'], details=plan['problems'])
        pins = self.pins()
        new_pins = dict(pins['pins'])
        for item in plan['items']:
            if item['kind'] == 'module' and item['id'] not in new_pins:
                new_pins[item['id']] = item['version']
        for item in plan['items']:
            if item['kind'] == 'packet':
                for ref in item['document']['modules']:
                    new_pins.setdefault(ref['id'], ref['version'])
        fresh = [item for item in plan['items'] if item['status'] == 'new']
        pin_change = new_pins != pins['pins']
        if pin_change and pins['revision'] >= MAX_REVISION:
            raise LessonStoreError('Revision limit reached.', 'revision_limit', 409, current_revision=pins['revision'])
        packet_ids = {}
        for item in plan['items']:
            if item['kind'] == 'packet':
                for ref in item['document']['modules']:
                    packet_ids.setdefault((ref['id'], ref['version']), []).append(item['id'])
        stamp = self.clock()
        for item in fresh:
            ids = sorted(set(packet_ids.get((item['id'], item['version']), []))) if item['kind'] == 'module' else None
            item['source'] = source_record(item['kind'], item['id'], item['version'], item['sha256'], item['size'], item['name'], stamp, ids)
        if fresh or pin_change:
            document = {'version': PINS_VERSION, 'revision': pins['revision'] + 1, 'pins': new_pins} if pin_change else None
            self.write_new(fresh, pins=document)
        return {'imported': [{k: item[k] for k in _SHOWN} for item in plan['items']], 'modules': self.list_modules()}

    def write_new(self, fresh, extra_files=(), pins=None):
        """Place new version folders, then extra files, then the pin file, all or nothing.

        `fresh` holds items with `kind`, `id`, `version`, `data`, and `source`.
        `extra_files` is a list of (path under the lessons folder, bytes).
        `pins` is the complete new pin document, or None to leave the pins alone.
        A failure removes what this call created and restores what it replaced.
        """
        created_dirs, placed, replaced = [], [], []
        stage = None
        existed = self.root.exists()

        def ensure(directory):
            directory = self._safe(directory)
            if not directory.exists():
                ensure(directory.parent)
                directory.mkdir()
                created_dirs.append(directory)

        try:
            ensure(self.root)
            stage = self._safe(self.root / f'.staging-{uuid.uuid4().hex}')
            stage.mkdir()
            for number, item in enumerate(fresh):
                folder = stage / str(number)
                self._atomic(folder / ('module.json' if item['kind'] == 'module' else 'packet.json'), item['data'])
                self._atomic(folder / 'source.json', _dump(item['source']))
            for number, item in enumerate(fresh):
                parent = self.root / ('modules' if item['kind'] == 'module' else 'packets') / item['id']
                ensure(parent)
                target = self._safe(parent / item['version'])
                (stage / str(number)).rename(target)
                placed.append(target)
            for relative, data in extra_files:
                path = self._safe(self.root / relative)
                ensure(path.parent)
                if path.exists():
                    replaced.append((path, path.read_bytes()))
                else:
                    placed.append(path)
                self._atomic(path, data)
            if pins is not None:
                path = self._safe(self.root / 'pins.json')
                if path.exists():
                    replaced.append((path, path.read_bytes()))
                else:
                    placed.append(path)
                self._atomic(path, _dump(pins))
        except BaseException:
            for path, old in reversed(replaced):
                try:
                    self._atomic(path, old)
                except OSError:
                    pass
            for target in reversed(placed):
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)
            if stage is not None:
                shutil.rmtree(stage, ignore_errors=True)
            for directory in reversed(created_dirs):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            raise
        shutil.rmtree(stage, ignore_errors=True)


def source_record(kind, identifier, version, sha256, size, file_name, imported_at, packet_ids=None):
    """The `source.json` content for one stored file."""
    record = {'version': 1, 'kind': kind, 'id': identifier, 'sha256': sha256, 'size': size,
              'fileName': file_name, 'importedAt': imported_at}
    record['moduleVersion' if kind == 'module' else 'packetVersion'] = version
    if kind == 'module':
        record['packetIds'] = list(packet_ids or [])
    return record


def _problem_code(reason):
    return {'invalid': 'invalid_lesson', 'unsupported_version': 'unsupported_version',
            'too_large': 'payload_too_large', 'unreadable': 'invalid_lesson'}[reason]


def _reject_constant(name):
    raise ValueError(f'{name} is not allowed in JSON.')


def _no_repeats(pairs):
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError('An object repeats a key.')
    return dict(pairs)
