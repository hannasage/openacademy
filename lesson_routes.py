"""The lesson routes of the local server, kept apart from `server.py`.

Routes (all on the local address, with the same Host and Origin rules as the
rest of the server, which `server.py` applies before it calls anything here):

    GET  /api/lessons                 list modules, their pins, and newer versions on offer
    GET  /api/lessons/export          the lesson backup file
    POST /api/lessons/import/preview  check a file and say what an import would do; writes nothing
    POST /api/lessons/import          import a module or packet, or restore a lesson backup
    POST /api/lessons/pins            move one pin; needs `confirm: true`
    POST /api/lessons/migrate         one-time progress migration for existing curricula

Import and preview take `{source, filename}`. `source` is one parsed document,
a list of documents, or the file text. Text is stored as sent. A parsed
document is stored as this server writes it back out, so send the text when the
exact bytes matter. A source whose `format` is `schola-lesson-backup` is a
backup and goes to restore.

A request body for these routes may be up to 5 MB. Other routes keep 2 MB.
"""
import json

import lesson_backup
import lesson_contract
import lesson_migrate
from lesson_store import LessonStore, LessonStoreError, clean_file_name

BODY_LIMIT = lesson_contract.MAX_BYTES
GET_ROUTES = ('/api/lessons', '/api/lessons/export')
POST_ROUTES = ('/api/lessons/import/preview', '/api/lessons/import', '/api/lessons/pins', '/api/lessons/migrate')


def is_lesson_route(path):
    return path in GET_ROUTES or path in POST_ROUTES


def _bad(message, field):
    return LessonStoreError(message, field=field)


def _document_bytes(value, field):
    if isinstance(value, str):
        data = value.encode('utf-8', errors='surrogatepass')
    elif isinstance(value, dict):
        try:
            data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')
        except (UnicodeError, ValueError):
            raise _bad('The lesson file cannot be stored as text.', field) from None
    else:
        raise _bad('Send one lesson file as text or as an object.', field)
    return data


def _is_backup(value):
    if isinstance(value, dict):
        return value.get('format') == lesson_backup.FORMAT
    if isinstance(value, str) and lesson_backup.FORMAT in value[:2000]:
        try:
            parsed = json.loads(value)
        except (ValueError, RecursionError):
            return False
        return isinstance(parsed, dict) and parsed.get('format') == lesson_backup.FORMAT
    return False


def _read_request(payload):
    """Split a request into ('backup', source) or ('files', [(name, bytes)])."""
    if not isinstance(payload, dict) or 'source' not in payload or set(payload) - {'source', 'filename'}:
        raise _bad('Send {source, filename}.', 'request')
    filename = payload.get('filename')
    if filename is not None and not isinstance(filename, str):
        raise _bad('The file name must be text.', 'filename')
    source = payload['source']
    if _is_backup(source):
        return 'backup', source
    items = source if isinstance(source, list) else [source]
    if not 1 <= len(items) <= 2000:
        raise _bad('Send between 1 and 2000 lesson files.', 'source')
    base = clean_file_name(filename) or 'lesson.json'
    files = []
    for index, item in enumerate(items):
        name = base if len(items) == 1 else f'{base.rsplit(".", 1)[0]}-{index + 1}.json'
        files.append((name, _document_bytes(item, f'source[{index}]' if isinstance(source, list) else 'source')))
    return 'files', files


def handle_get(lessons, path):
    if path == '/api/lessons':
        return 200, lessons.list_modules()
    if path == '/api/lessons/export':
        return 200, lesson_backup.export_backup(lessons)
    return None


def handle_post(lessons, path, payload, local=None):
    if path == '/api/lessons/pins':
        allowed = {'moduleId', 'version', 'confirm', 'expectedRevision'}
        if not isinstance(payload, dict) or not {'moduleId', 'version', 'confirm'} <= set(payload) or set(payload) - allowed:
            raise _bad('Send {moduleId, version, confirm, expectedRevision?}.', 'request')
        expected = payload.get('expectedRevision', lessons.pins()['revision'])
        return 200, lessons.set_pin(payload['moduleId'], payload['version'], payload['confirm'], expected)
    if path == '/api/lessons/migrate':
        if payload != {}:
            raise _bad('Send an empty object.', 'request')
        return 200, lesson_migrate.migrate(lessons, local)
    kind, source = _read_request(payload)
    preview = path == '/api/lessons/import/preview'
    if kind == 'backup':
        return 200, (lesson_backup.preview_restore if preview else lesson_backup.restore_backup)(lessons, source)
    return 200, (lessons.preview_import if preview else lessons.import_files)(source)
