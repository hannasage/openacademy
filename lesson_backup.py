"""Help records, and a backup file for imported lesson modules.

The backup is a new file format, `schola-lesson-backup`, described by
`contracts/lesson-backup.v1.schema.json`. The older record backup format is not
touched. A backup holds:

* every stored module and packet, as the exact text that was imported, with its
  digest and the facts from its `source.json`;
* the pins, with their revision;
* the help records of each module.

It holds no progress. Progress for an existing curriculum lives in its record,
and the record backup already covers that.

Help records live in `_lessons/help/<module-id>.json` as
`{version, revision, records}`. This step stores and exports them. No route adds
one yet.

Restoring is all or nothing. The file is checked in full before any write: the
schema, every digest, every module and packet with the lesson validator, every
reference between files, and every help record. Restoring into an empty folder
rebuilds the same files. Restoring into a used folder adds what is missing:

* a version that is already stored with the same bytes is skipped;
* a version stored with different bytes stops the restore;
* a pin is set only for a module that has no pin, so a restore never moves one;
* help records are added after the ones already stored, without repeats.

Only the Python standard library is used.
"""
import datetime
import hashlib
import json
from pathlib import Path
import re

import lesson_contract
from lesson_store import (
    LessonStoreError, PINS_VERSION, _VERSION, _dump, _no_repeats, _reject_constant, source_record, version_key,
)
from local_store import MAX_REVISION

FORMAT = 'schola-lesson-backup'
BACKUP_SCHEMA_ID = 'urn:schola:contract:lesson-backup:v1'
HELP_VERSION = 1
MAX_BYTES = lesson_contract.MAX_BYTES
_ID = re.compile(r'[a-z0-9][a-z0-9-]{0,59}', re.ASCII)

_registry = None


def backup_registry():
    """The schemas the backup needs, loaded once from the contracts folder."""
    global _registry
    if _registry is None:
        folder = lesson_contract.CONTRACTS_DIRECTORY
        names = ('lesson-backup.v1.schema.json', 'lesson-common.v1.schema.json', 'help-record.v1.schema.json')
        _registry = lesson_contract.SchemaRegistry([json.loads((folder / name).read_text(encoding='utf-8')) for name in names])
    return _registry


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---------------------------------------------------------------------------
# Help records
# ---------------------------------------------------------------------------

def _help_path(lessons, module_id):
    return lessons._safe(lessons.root / 'help' / f'{module_id}.json')


def _check_help_record(record):
    result = lesson_contract.validate_lesson_contract('help-record', record)
    if not result['ok']:
        raise ValueError()


def read_help(lessons, module_id):
    """The help file of one module, or an empty one when none was written. Never writes."""
    if not isinstance(module_id, str) or not _ID.fullmatch(module_id):
        raise LessonStoreError('Invalid module id.', field='moduleId')
    path = _help_path(lessons, module_id)
    if not path.exists():
        return {'version': HELP_VERSION, 'revision': 0, 'records': []}
    value = lessons._read_json(path)
    try:
        if (not isinstance(value, dict) or set(value) != {'version', 'revision', 'records'}
                or type(value['version']) is not int or value['version'] != HELP_VERSION
                or type(value['revision']) is not int or not 0 <= value['revision'] <= MAX_REVISION
                or not isinstance(value['records'], list)):
            raise ValueError()
        for record in value['records']:
            _check_help_record(record)
            if record['moduleId'] != module_id:
                raise ValueError()
    except ValueError:
        raise LessonStoreError('A saved help file is invalid. It was preserved.', 'corrupt_file', 500) from None
    return value


def help_module_ids(lessons):
    folder = lessons._safe(lessons.root / 'help')
    if not folder.is_dir():
        return []
    names = []
    for path in sorted(folder.iterdir()):
        if path.name.startswith('.'):
            continue
        lessons._safe(path)
        if not path.is_file() or path.suffix != '.json' or not _ID.fullmatch(path.stem):
            raise LessonStoreError('Unexpected entry in the help folder. It was preserved.', 'corrupt_file', 500)
        names.append(path.stem)
    return names


def help_file_bytes(module_id, revision, records):
    return _dump({'version': HELP_VERSION, 'revision': revision, 'records': records})


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export_backup(lessons, clock=_now):
    """Read everything stored and return the backup as a plain dict. Writes nothing."""
    modules, packets = [], []
    for module_id in lessons.module_ids():
        for version in lessons.versions(module_id):
            data = lessons.module_bytes(module_id, version)
            source = lessons.source('module', module_id, version)
            modules.append({'id': module_id, 'version': version, 'sha256': _sha(data), 'text': data.decode('utf-8'),
                            'source': {'fileName': source['fileName'], 'importedAt': source['importedAt'],
                                       'packetIds': list(source.get('packetIds', []))}})
    for packet_id in lessons.packet_ids():
        for version in sorted(lessons._children(lessons.root / 'packets' / packet_id, _VERSION), key=version_key):
            data = lessons._stored_bytes(lessons._packet_dir(packet_id, version), 'packet.json')
            source = lessons.source('packet', packet_id, version)
            packets.append({'id': packet_id, 'version': version, 'sha256': _sha(data), 'text': data.decode('utf-8'),
                            'source': {'fileName': source['fileName'], 'importedAt': source['importedAt']}})
    pins = lessons.pins()
    help_groups = []
    for module_id in help_module_ids(lessons):
        stored = read_help(lessons, module_id)
        help_groups.append({'moduleId': module_id, 'revision': stored['revision'], 'records': stored['records']})
    backup = {'format': FORMAT, 'schemaVersion': '1.0', 'createdAt': clock(), 'modules': modules, 'packets': packets,
              'pins': {'revision': pins['revision'], 'pins': dict(sorted(pins['pins'].items()))}, 'help': help_groups}
    if len(json.dumps(backup).encode('utf-8')) > MAX_BYTES:
        raise LessonStoreError('The lessons are too large for one backup file (5 MB limit).', 'payload_too_large', 413)
    return backup


# ---------------------------------------------------------------------------
# Checking a backup
# ---------------------------------------------------------------------------

def _problem(code, status, message, pointer='', file=None):
    found = {'code': code, 'status': status, 'errors': [{'pointer': pointer, 'message': message}]}
    if file is not None:
        found['file'] = file
    return found


def parse_backup(source):
    """Turn text, bytes, or a parsed object into a parsed object. Raises LessonStoreError."""
    if isinstance(source, (bytes, bytearray, str)):
        data = source.encode('utf-8', errors='surrogatepass') if isinstance(source, str) else bytes(source)
        if len(data) > MAX_BYTES:
            raise LessonStoreError('The backup is larger than the 5 MB limit.', 'payload_too_large', 413)
        try:
            return json.loads(data.decode('utf-8'), parse_constant=_reject_constant, object_pairs_hook=_no_repeats)
        except (ValueError, UnicodeError, RecursionError):
            raise LessonStoreError('The backup is not complete, valid JSON.', 'invalid_lesson', 422) from None
    return source


def plan_restore(lessons, source):
    """Check a backup in full against the current store. Writes nothing.

    Returns a plan: `problems` (empty when the restore can run), and when it
    can, the files to place, the pin document, and the help files to write.
    """
    document = parse_backup(source)
    if not isinstance(document, dict) or document.get('format') != FORMAT:
        return {'problems': [_problem('invalid_lesson', 422, 'This is not a Schola lesson backup.', '/format')]}
    marker = document.get('schemaVersion')
    if isinstance(marker, str) and re.match(r'^[0-9]+\.', marker) and not marker.startswith('1.'):
        return {'problems': [_problem('unsupported_version', 409, 'This backup needs a newer version of Schola.', '/schemaVersion')]}
    try:
        found = backup_registry().validate(BACKUP_SCHEMA_ID, document)
    except RecursionError:
        found = [('', 'The document is nested too deeply.')]
    if found:
        return {'problems': [dict(_problem('invalid_lesson', 422, message, pointer)) for pointer, message in found[:20]]}
    problems = []
    fresh, texts = [], {}
    for kind, key in (('module', 'modules'), ('packet', 'packets')):
        seen = set()
        for index, entry in enumerate(document[key]):
            where = f'/{key}/{index}'
            name = f"{entry['id']}@{entry['version']}"
            if (entry['id'], entry['version']) in seen:
                problems.append(_problem('version_conflict', 409, 'This id and version appear twice in the backup.', where, name))
                continue
            seen.add((entry['id'], entry['version']))
            try:
                data = entry['text'].encode('utf-8')
            except UnicodeError:
                problems.append(_problem('invalid_lesson', 422, 'The text is not valid UTF-8.', where + '/text', name))
                continue
            if _sha(data) != entry['sha256']:
                problems.append(_problem('invalid_lesson', 422, 'The text does not match its digest.', where + '/sha256', name))
                continue
            contract = 'lesson-module' if kind == 'module' else 'packet'
            result = lesson_contract.validate_lesson_text(contract, data)
            if not result['ok']:
                problems.append(dict(_problem('invalid_lesson' if result['reason'] != 'unsupported_version' else 'unsupported_version',
                                              422 if result['reason'] != 'unsupported_version' else 409, result['errors'][0]['message'], where + '/text', name),
                                     errors=result['errors'][:20]))
                continue
            parsed = json.loads(data.decode('utf-8'))
            if parsed['id'] != entry['id'] or parsed['version'] != entry['version']:
                problems.append(_problem('invalid_lesson', 422, 'The id and version do not match the stored text.', where, name))
                continue
            state = lessons._stored_state(kind, entry['id'], entry['version'], data)
            if state == 'different':
                problems.append(_problem('version_conflict', 409, 'This id and version are already stored with different content.', where, name))
                continue
            texts[(kind, entry['id'], entry['version'])] = parsed
            if state == 'new':
                source_data = entry['source']
                fresh.append({'kind': kind, 'id': entry['id'], 'version': entry['version'], 'data': data, 'title': parsed['title'],
                              'source': source_record(kind, entry['id'], entry['version'], entry['sha256'], len(data),
                                                      source_data['fileName'], source_data['importedAt'],
                                                      source_data.get('packetIds') if kind == 'module' else None)})
    if problems:
        return {'problems': problems}

    def has_module(module_id, version):
        return ('module', module_id, version) in texts or lessons._has_module(module_id, version)

    for index, entry in enumerate(document['packets']):
        parsed = texts[('packet', entry['id'], entry['version'])]
        for position, ref in enumerate(parsed['modules']):
            if not has_module(ref['id'], ref['version']):
                problems.append(_problem('missing_module', 422, 'The packet names a module version that is not in the backup or the store.',
                                         f'/packets/{index}/text#/modules/{position}', f"{entry['id']}@{entry['version']}"))
    current = lessons.pins()
    merged = dict(current['pins'])
    for module_id, version in document['pins']['pins'].items():
        if not has_module(module_id, version):
            problems.append(_problem('missing_module', 422, 'A pin names a module version that is not in the backup or the store.', f'/pins/pins/{module_id}'))
        elif module_id not in merged:
            merged[module_id] = version
    task_ids = {}
    for (kind, module_id, _), parsed in texts.items():
        if kind == 'module':
            task_ids.setdefault(module_id, set()).update(t['id'] for t in parsed['tasks'])
    help_files = []
    for index, group in enumerate(document['help']):
        module_id = group['moduleId']
        known = task_ids.setdefault(module_id, set())
        for version in lessons.versions(module_id):
            if ('module', module_id, version) not in texts:
                known.update(t['id'] for t in lessons.get_module(module_id, version)['tasks'])
        if not known:
            problems.append(_problem('missing_module', 422, 'Help records name a module that is not in the backup or the store.', f'/help/{index}/moduleId'))
            continue
        for position, record in enumerate(group['records']):
            result = lesson_contract.validate_lesson_contract('help-record', record)
            if not result['ok']:
                problems.append(dict(_problem('invalid_lesson', 422, result['errors'][0]['message'], f'/help/{index}/records/{position}'), errors=result['errors'][:20]))
            elif record['moduleId'] != module_id or record['taskId'] not in known:
                problems.append(_problem('invalid_lesson', 422, 'A help record names a module or task that does not exist.', f'/help/{index}/records/{position}'))
    if problems:
        return {'problems': problems}
    for group in document['help']:
        stored = read_help(lessons, group['moduleId'])
        existing = stored['records']
        added = [r for i, r in enumerate(group['records']) if r not in existing and r not in group['records'][:i]]
        if not added:
            continue
        exists = _help_path(lessons, group['moduleId']).exists()
        revision = stored['revision'] + 1 if exists else group['revision']
        if revision > MAX_REVISION:
            return {'problems': [_problem('revision_limit', 409, 'Revision limit reached.')]}
        help_files.append((f"help/{group['moduleId']}.json", help_file_bytes(group['moduleId'], revision, existing + added)))
    pins_document = None
    if merged != current['pins']:
        revision = current['revision'] + 1 if (lessons.root / 'pins.json').exists() else document['pins']['revision']
        if revision > MAX_REVISION:
            return {'problems': [_problem('revision_limit', 409, 'Revision limit reached.')]}
        pins_document = {'version': PINS_VERSION, 'revision': revision, 'pins': merged}
    return {'problems': [], 'fresh': fresh, 'help_files': help_files, 'pins': pins_document,
            'counts': {'modules': len(document['modules']), 'packets': len(document['packets']),
                       'pins': len(document['pins']['pins']), 'helpRecords': sum(len(g['records']) for g in document['help'])},
            'texts': texts, 'document': document}


def _summary(lessons, plan):
    new = {(item['kind'], item['id'], item['version']) for item in plan['fresh']}
    entries = []
    for (kind, identifier, version), parsed in sorted(plan['texts'].items(), key=lambda kv: (kv[0][0], kv[0][1], version_key(kv[0][2]))):
        entries.append({'kind': kind, 'id': identifier, 'version': version, 'title': parsed['title'],
                        'status': 'new' if (kind, identifier, version) in new else 'already-stored'})
    return {'importable': True, 'kind': 'backup', 'files': entries, 'problems': [], 'counts': plan['counts'],
            'pinsToSet': sorted((plan['pins'] or {}).get('pins', {}).keys() - lessons.pins()['pins'].keys()),
            'helpFilesToWrite': len(plan['help_files'])}


def preview_restore(lessons, source):
    """What a restore would do. Writes nothing at all."""
    plan = plan_restore(lessons, source)
    if plan['problems']:
        return {'importable': False, 'kind': 'backup', 'files': [], 'problems': plan['problems']}
    return _summary(lessons, plan)


def restore_backup(lessons, source):
    """Restore a backup or change nothing. Returns what was done and the new module list."""
    plan = plan_restore(lessons, source)
    if plan['problems']:
        first = plan['problems'][0]
        raise LessonStoreError(first['errors'][0]['message'], first['code'], first['status'], details=plan['problems'])
    summary = _summary(lessons, plan)
    if plan['fresh'] or plan['help_files'] or plan['pins'] is not None:
        lessons.write_new(plan['fresh'], extra_files=plan['help_files'], pins=plan['pins'])
    summary['modules'] = lessons.list_modules()
    return summary
