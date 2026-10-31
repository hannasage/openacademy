"""Versioned local records; cloud scope is a local filter, not authentication."""
import copy
import hashlib
import json
import math
import os
import re
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from uuid import UUID, uuid4, uuid5

MIGRATION_NAMESPACE = UUID('802bb776-0586-497f-a065-f02f9d669074')
STATUSES = ('active', 'paused', 'completed', 'saved')
MAX_REVISION = 9007199254740991


class StoreError(ValueError):
    def __init__(self, message, code='invalid_record', status=400, field=None,
                 retryable=False, current_revision=None):
        super().__init__(message)
        self.code, self.status, self.field = code, status, field
        self.retryable, self.current_revision = retryable, current_revision

    def payload(self):
        result = {'error': str(self), 'code': self.code, 'retryable': self.retryable}
        if self.field is not None:
            result['field'] = self.field
        if self.current_revision is not None:
            result['currentRevision'] = self.current_revision
        return result


def finite_json(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise StoreError('Numbers must be finite.', field='number')
    if isinstance(value, dict):
        if any(not isinstance(k, str) for k in value):
            raise StoreError('Object keys must be text.')
        for item in value.values():
            finite_json(item)
    elif isinstance(value, list):
        for item in value:
            finite_json(item)
    elif not isinstance(value, (str, int, float, bool, type(None))):
        raise StoreError('Expected JSON data.')


def strict_keys(value, keys, field):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise StoreError(f'Invalid {field} fields.', field=field)


def uuid_text(value, field):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError):
        raise StoreError(f'{field} must be a canonical UUID.', field=field) from None
    return value


def validate_origin(origin):
    if not isinstance(origin, dict):
        raise StoreError('Invalid record origin.', field='origin')
    if origin.get('kind') == 'local':
        strict_keys(origin, ['kind'], 'origin')
    elif origin.get('kind') == 'cloud':
        strict_keys(origin, ['kind', 'hubId', 'backendOrigin', 'accountId'], 'origin')
        uuid_text(origin['hubId'], 'origin.hubId')
        uuid_text(origin['accountId'], 'origin.accountId')
        backend = origin['backendOrigin']
        try:
            url = urlsplit(backend)
            host = url.hostname
            if not isinstance(backend, str) or not host or url.scheme != 'https' or url.username or url.password or url.path or url.query or url.fragment:
                raise ValueError()
            authority = f'[{host}]' if ':' in host else host.encode('idna').decode('ascii')
            if url.port is not None and url.port != 443:
                authority += f':{url.port}'
            if backend != f'https://{authority}' or not re.fullmatch(r'https://(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::[1-9][0-9]{0,4})?', backend):
                raise ValueError()
        except (ValueError, TypeError, AttributeError, UnicodeError):
            raise StoreError('Use a canonical HTTPS backend origin.', field='origin.backendOrigin') from None
    else:
        raise StoreError('Unknown record origin.', field='origin.kind')
    return origin


class LocalStore:
    def __init__(self, data_dir, built_in, validate_curriculum, validate_progress, initial_progress):
        self.root = Path(data_dir).absolute()
        self.built_in = copy.deepcopy(built_in)
        self.validate_curriculum = validate_curriculum
        self.validate_progress = validate_progress
        self.initial_progress = initial_progress

    def _safe(self, path):
        path = Path(path)
        try:
            relative = path.relative_to(self.root)
        except ValueError:
            raise StoreError('Invalid data path.', 'unsafe_path') from None
        current = self.root
        for part in (None, *relative.parts):
            if part is not None:
                if part in ('.', '..'):
                    raise StoreError('Invalid data path.', 'unsafe_path')
                current /= part
            if current.is_symlink():
                raise StoreError('Data paths cannot be symbolic links.', 'unsafe_path', 500)
        return path

    def _read(self, path):
        path = self._safe(path)
        try:
            return json.loads(path.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (ValueError, UnicodeError) as error:
            raise StoreError('A saved file is damaged. The file was preserved.', 'corrupt_file', 500) from error

    def _atomic(self, path, data):
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

    def _write(self, path, value, backup=False):
        data = (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()
        path = self._safe(path)
        if backup and path.exists():
            self._atomic(path.with_name('record.backup.json'), path.read_bytes())
        self._atomic(path, data)

    def _course(self, course):
        finite_json(course)
        if not isinstance(course, dict) or ('version' in course and (type(course['version']) is not int or course['version'] != 1)):
            raise StoreError('Unsupported curriculum version.', 'unsupported_version', field='curriculum.version')
        try:
            return self.validate_curriculum(course)
        except (ValueError, TypeError, KeyError) as error:
            raise StoreError(str(error), field=getattr(error, 'field', 'curriculum')) from error

    def _state(self, state, course):
        finite_json(state)
        if not isinstance(state, dict) or type(state.get('version')) is not int or state['version'] != 1:
            raise StoreError('Unsupported progress version.', 'unsupported_version', field='state.version')
        if type(state.get('revision')) is not int or not 0 <= state['revision'] <= MAX_REVISION:
            raise StoreError('Invalid progress revision.', field='state.revision')
        try:
            return self.validate_progress(state, course)
        except (ValueError, TypeError, KeyError) as error:
            raise StoreError(str(error), field='state') from error

    def _validate(self, record):
        finite_json(record)
        # Inspect the format before applying this version's shape. Newer formats
        # can add fields and must never become damaged-record recovery candidates.
        if not isinstance(record, dict) or record.get('format') != 'touchline-record' or type(record.get('version')) is not int or record['version'] != 2:
            raise StoreError('Unsupported record format or version.', 'unsupported_version', field='version')
        strict_keys(record, ['format', 'version', 'recordId', 'origin', 'curriculum', 'state', 'status', 'view', 'draft'], 'record')
        uuid_text(record['recordId'], 'recordId')
        validate_origin(record['origin'])
        self._course(record['curriculum'])
        self._state(record['state'], record['curriculum'])
        if record['status'] not in STATUSES:
            raise StoreError('Invalid record status.', field='status')
        modules = {m['id'] for m in record['curriculum']['modules']}
        strict_keys(record['view'], ['selectedModuleId'], 'view')
        if not isinstance(record['view']['selectedModuleId'], str) or record['view']['selectedModuleId'] not in modules:
            raise StoreError('Select a lesson in this curriculum.', field='view.selectedModuleId')
        strict_keys(record['draft'], ['experiment'], 'draft')
        draft = record['draft']['experiment']
        if draft is not None:
            strict_keys(draft, ['id', 'date', 'module', 'title', 'hypothesis', 'result'], 'draft.experiment')
            if draft['id'] is not None and (not isinstance(draft['id'], str) or not draft['id'] or len(draft['id']) > 20000):
                raise StoreError('Invalid draft experiment ID.', field='draft.experiment.id')
            if any(not isinstance(draft[k], str) or len(draft[k]) > 20000 for k in ('date', 'module', 'title', 'hypothesis', 'result')):
                raise StoreError('Invalid experiment draft.', field='draft.experiment')
            if draft['module'] not in modules:
                raise StoreError('Select a lesson for the draft.', field='draft.experiment.module')
            if draft['date']:
                from datetime import date
                try:
                    if len(draft['date']) != 10:
                        raise ValueError()
                    date.fromisoformat(draft['date'])
                except ValueError:
                    raise StoreError('Invalid draft date.', field='draft.experiment.date') from None
        return record

    def _new(self, course, state, origin, status, record_id=None):
        return {'format': 'touchline-record', 'version': 2, 'recordId': record_id or str(uuid4()),
                'origin': copy.deepcopy(origin), 'curriculum': copy.deepcopy(course), 'state': copy.deepcopy(state),
                'status': status, 'view': {'selectedModuleId': course['modules'][0]['id']}, 'draft': {'experiment': None}}

    def _path(self, record_id):
        uuid_text(record_id, 'recordId')
        return self._safe(self.root / 'records' / record_id / 'record.json')

    def _records(self):
        folder = self._safe(self.root / 'records')
        result = []
        if not folder.exists():
            return result
        for directory in sorted(folder.iterdir()):
            self._safe(directory)
            if not directory.is_dir():
                raise StoreError('Unexpected file in the records folder.', 'corrupt_file', 500)
            try:
                uuid_text(directory.name, 'recordId')
                target = self._safe(directory / 'record.json')
                if not target.exists():
                    # A failed first write may leave an empty directory, never a record.
                    if list(directory.iterdir()):
                        raise StoreError('An incomplete record needs recovery.', 'corrupt_file', 500)
                    continue
                record = self._validate(self._read(target))
                if record['recordId'] != directory.name:
                    raise StoreError('Record ID does not match its folder.')
                result.append(record)
            except StoreError as error:
                if error.code == 'unsupported_version':
                    raise StoreError('A saved record uses an unsupported version. Update Schola before opening or restoring it. The file was preserved.', 'unsupported_version', 409) from error
                if error.status == 400:
                    raise StoreError('A saved record is invalid. The file was preserved.', 'corrupt_file', 500) from error
                raise
        identities = [self._identity(record) for record in result]
        if len(set(identities)) != len(identities):
            raise StoreError('Saved records contain duplicate identities.', 'identity_collision', 500)
        return result

    @staticmethod
    def _identity(record):
        return (json.dumps(record['origin'], sort_keys=True), record['curriculum']['id'])

    def _migration_plan(self):
        records = self._records()
        existing = {r['curriculum']['id']: r for r in records if r['origin']['kind'] == 'local'}
        courses = [self.built_in]
        folder = self._safe(self.root / 'curricula')
        if folder.exists():
            courses.extend(self._read(self._safe(path)) for path in sorted(folder.glob('*.json')))
        pending, ids = [], set()
        try:
            for course in courses:
                self._course(course)
                if course['id'] in ids:
                    raise StoreError('Legacy curricula contain a duplicate ID.')
                ids.add(course['id'])
                if course['id'] in existing:
                    continue
                target = self._safe(self.root / course['id'] / 'state.json')
                state = self._read(target) if target.exists() else self.initial_progress(course)
                self._state(state, course)
                record_id = str(uuid5(MIGRATION_NAMESPACE, 'local:' + course['id']))
                if any(r['recordId'] == record_id for r in records):
                    raise StoreError('Migration ID is already occupied.', 'identity_collision', 409)
                pending.append(self._validate(self._new(course, state, {'kind': 'local'}, 'active', record_id)))
        except StoreError as error:
            if error.status == 400:
                raise StoreError('A legacy file is invalid. Originals were preserved.', 'corrupt_legacy', 500) from error
            raise
        return records, pending

    def _migrate(self):
        records, pending = self._migration_plan()
        # Validate all originals before creating any migration output.
        for record in pending:
            self._write(self._path(record['recordId']), record)
        return records + pending

    @staticmethod
    def _visible(record, scope):
        return record['origin']['kind'] == 'local' or record['origin'] == scope

    def _scope(self, scope):
        if scope is not None:
            validate_origin(scope)
            if scope['kind'] != 'cloud':
                raise StoreError('Expected a cloud scope.', field='scope')
        return scope

    def local_record(self, curriculum_id):
        for record in self._migrate():
            if record['origin']['kind'] == 'local' and record['curriculum']['id'] == curriculum_id:
                return copy.deepcopy(record)
        raise StoreError('Unknown curriculum.', 'not_found', 404)

    def get_record(self, record_id, scope=None):
        uuid_text(record_id, 'recordId')
        self._scope(scope)
        for record in self._migrate():
            if record['recordId'] == record_id and self._visible(record, scope):
                return copy.deepcopy(record)
        raise StoreError('Record not found in this connection.', 'not_found', 404)

    def _library(self, records):
        target = self._safe(self.root / 'library.json')
        value = self._read(target) if target.exists() else {'version': 1, 'revision': 0, 'focusRecordId': None}
        try:
            strict_keys(value, ['version', 'revision', 'focusRecordId'], 'library')
            if type(value['version']) is not int or value['version'] != 1 or type(value['revision']) is not int or not 0 <= value['revision'] <= MAX_REVISION:
                raise StoreError('Invalid library version or revision.')
            if value['focusRecordId'] is not None:
                uuid_text(value['focusRecordId'], 'focusRecordId')
        except StoreError as error:
            raise StoreError('The saved library is invalid. Its file was preserved.', 'corrupt_file', 500) from error
        if value['focusRecordId'] is not None and not any(r['recordId'] == value['focusRecordId'] and r['status'] == 'active' for r in records):
            value = dict(value, revision=self._next_revision(value['revision']), focusRecordId=None)
            self._write(target, value)
        return value

    def library(self, scope=None):
        self._scope(scope)
        records = self._migrate()
        library = self._library(records)
        visible = [r for r in records if self._visible(r, scope)]
        if library['focusRecordId'] not in {r['recordId'] for r in visible}:
            library = dict(library, focusRecordId=None)
        return dict(library, records=[{'recordId': r['recordId'], 'origin': r['origin'],
            'curriculumId': r['curriculum']['id'], 'title': r['curriculum']['title'], 'status': r['status'],
            'revision': r['state']['revision'], 'selectedModuleId': r['view']['selectedModuleId']} for r in visible])

    @staticmethod
    def _next_revision(current):
        if current >= MAX_REVISION:
            raise StoreError('Revision limit reached. Export this record before recovery.', 'revision_limit', 409, current_revision=current)
        return current + 1

    @staticmethod
    def _revision(expected, actual):
        if type(expected) is not int or not 0 <= expected <= MAX_REVISION:
            raise StoreError('Expected revision must be a nonnegative integer.', field='expectedRevision')
        if expected != actual:
            raise StoreError('Newer changes were saved. Keep your edits and reload before retrying.',
                             'revision_conflict', 409, retryable=False, current_revision=actual)

    def save_library(self, expected_revision, focus_record_id, scope=None):
        self._scope(scope)
        records = self._migrate()
        library = self._library(records)
        self._revision(expected_revision, library['revision'])
        if focus_record_id is not None:
            uuid_text(focus_record_id, 'focusRecordId')
            if not any(r['recordId'] == focus_record_id and r['status'] == 'active' and self._visible(r, scope) for r in records):
                raise StoreError('Focus must be an active record in this connection.', field='focusRecordId')
        saved = dict(library, revision=self._next_revision(library['revision']), focusRecordId=focus_record_id)
        self._write(self.root / 'library.json', saved)
        return self.library(scope)

    def save_record(self, record_id, expected_revision, record, scope=None):
        self._validate(record)
        current = self.get_record(record_id, scope)
        self._revision(expected_revision, current['state']['revision'])
        if record['recordId'] != record_id or self._identity(record) != self._identity(current):
            raise StoreError('Record ID, origin, and curriculum ID cannot change.', 'identity_immutable', 409)
        if record['state']['revision'] != expected_revision:
            raise StoreError('Record revision must match expectedRevision.', field='state.revision')
        # Repair an earlier pause before a record can become active again. A failed
        # repair prevents the update, so a stale focus never reappears after restart.
        self._library(self._migrate())
        saved = copy.deepcopy(record)
        saved['state']['revision'] = self._next_revision(current['state']['revision'])
        self._write(self._path(record_id), saved, backup=True)
        # Focus is derived from active status on reads, then persisted. Record
        # status is authoritative; no second-file failure can undo a saved record.
        return saved

    def save_legacy_state(self, curriculum_id, state):
        current = self.local_record(curriculum_id)
        self._state(state, current['curriculum'])
        current['state'] = copy.deepcopy(state)
        return self.save_record(current['recordId'], state['revision'], current)['state']

    def _recovery_candidate(self, record_id):
        path = self._path(record_id)
        damaged = path.read_bytes() if path.exists() else b''
        try:
            current = self._validate(self._read(path))
        except StoreError as error:
            if error.code == 'unsupported_version':
                raise
            current = None
        except FileNotFoundError:
            current = None
        if current is not None:
            raise StoreError('This record is readable. Use Restore backup to replace its progress.', 'not_damaged', 409)
        backup = self._validate(self._read(self._safe(path.with_name('record.backup.json'))))
        if backup['recordId'] != record_id or backup['origin'] != {'kind': 'local'}:
            raise StoreError('No verified local backup is available for this record.', 'not_found', 404)
        return backup, damaged

    def recovery_options(self):
        folder = self._safe(self.root / 'records')
        if not folder.exists():
            return []
        options = []
        for directory in sorted(folder.iterdir()):
            self._safe(directory)
            if not directory.is_dir():
                continue
            try:
                backup, damaged = self._recovery_candidate(directory.name)
            except (StoreError, FileNotFoundError):
                continue
            reserved = self._recovery_revision(directory.name)
            options.append({'recordId': backup['recordId'], 'title': backup['curriculum']['title'],
                            'revision': backup['state']['revision'], 'damagedDigest': self._recovery_digest(backup, damaged, reserved)})
        return options

    def _recovery_revision(self, record_id):
        path = self._safe(self._path(record_id).with_name('recovery-state.json'))
        if not path.exists():
            return 0
        value = self._read(path)
        strict_keys(value, ['version', 'revision'], 'recovery')
        if type(value['version']) is not int or value['version'] != 1 or type(value['revision']) is not int or not 0 <= value['revision'] <= MAX_REVISION:
            raise StoreError('Recovery history is invalid. Keep all files and repair it before restoring.', 'invalid_recovery', 409)
        return value['revision']

    @staticmethod
    def _recovery_digest(backup, damaged, reserved):
        review = {'backup': backup, 'reservedRevision': reserved}
        return hashlib.sha256(damaged + b'\0' + json.dumps(review, sort_keys=True).encode()).hexdigest()

    def recover_record(self, record_id, expected_digest):
        backup, damaged = self._recovery_candidate(record_id)
        reserved = self._recovery_revision(record_id)
        digest = self._recovery_digest(backup, damaged, reserved)
        if expected_digest != digest:
            raise StoreError('The damaged record changed. Reload recovery before trying again.', 'revision_conflict', 409)
        path = self._path(record_id)
        self._atomic(path.with_name('record.damaged-' + digest + '.json'), damaged)
        # Reserve a new revision before replacing the record. A failed record
        # write consumes this revision so retries and repeated recoveries cannot
        # accept a writer holding any earlier recovered copy. Keep the backup intact.
        revision = self._next_revision(max(self._next_revision(backup['state']['revision']), reserved))
        self._write(path.with_name('recovery-state.json'), {'version': 1, 'revision': revision})
        backup['state']['revision'] = revision
        self._write(path, backup)
        return backup

    def preview_import(self, source, origin, status, target_record_id=None, expected_revision=None, scope=None):
        validate_origin(origin)
        if status not in STATUSES:
            raise StoreError('Invalid record status.', field='status')
        if not isinstance(source, dict):
            raise StoreError('Expected a curriculum backup.', field='source')
        if source.get('format') == 'touchline-record' or 'recordId' in source:
            self._validate(source)
            candidate = copy.deepcopy(source)
            candidate.update(recordId=str(uuid4()), origin=copy.deepcopy(origin), status=status)
        else:
            keys = ['curriculum', 'state']
            if 'format' in source:
                if source['format'] != 'touchline-backup':
                    raise StoreError('Unsupported backup format.', 'unsupported_version', field='source.format')
                keys.append('format')
            strict_keys(source, keys, 'source')
            self._course(source['curriculum'])
            self._state(source['state'], source['curriculum'])
            candidate = self._new(source['curriculum'], source['state'], origin, status)
        candidate['state']['revision'] = 0
        self._validate(candidate)
        existing, pending = self._migration_plan()
        readable = existing + pending
        if target_record_id is not None:
            uuid_text(target_record_id, 'targetRecordId')
            self._scope(scope)
            current = next((record for record in readable if record['recordId'] == target_record_id and self._visible(record, scope)), None)
            if current is None:
                raise StoreError('Record not found in this connection.', 'not_found', 404)
            self._revision(expected_revision, current['state']['revision'])
            if self._identity(candidate) != self._identity(current):
                raise StoreError('Replacement must retain the target origin and curriculum ID.', 'identity_immutable', 409)
            candidate['recordId'] = target_record_id
            candidate['state']['revision'] = current['state']['revision']
            return candidate
        if expected_revision is not None:
            raise StoreError('expectedRevision requires targetRecordId.', field='expectedRevision')
        if any(self._identity(record) == self._identity(candidate) for record in readable):
            raise StoreError('This curriculum already exists in this connection. Choose its record to replace it.', 'identity_collision', 409)
        return candidate

    def import_record(self, source, origin, status, target_record_id=None, expected_revision=None, scope=None):
        candidate = self.preview_import(source, origin, status, target_record_id, expected_revision, scope)
        self._migrate()
        if target_record_id is not None:
            return self.save_record(target_record_id, expected_revision, candidate, scope)
        self._write(self._path(candidate['recordId']), candidate)
        return candidate
