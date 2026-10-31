const ROUTES = {
  list: '/api/lessons',
  preview: '/api/lessons/import/preview',
  import: '/api/lessons/import',
  pins: '/api/lessons/pins',
  export: '/api/lessons/export',
  migrate: '/api/lessons/migrate',
};
const DETAIL_LIMIT = 300;
const GENERIC_TEXT = 'The local server could not finish this request.';
/** The biggest request body the web side sends. The server allows 5,242,880 bytes. This leaves a margin. */
export const MAX_REQUEST_BYTES = 5_000_000;
const TOO_LARGE_TEXT = 'This is too large to send. Lesson files and lesson backups may be up to 5 MB. Curriculum and progress files may be up to 2 MB. Nothing was changed.';
/**
 * Every code the lesson routes can answer with. The web side reads the code first.
 * A code that is not listed here gets a neutral message that shows the code. No status ever stands in for a code.
 * @type {Record<string, {code: LessonErrorCode, text: string}>}
 */
const CODE_TEXT = {
  invalid_lesson: {code: 'invalid', text: 'This is not a valid lesson file. Nothing was changed.'},
  missing_module: {code: 'missing_module', text: 'This lesson set names a module that is not in your library or in this import. Nothing was changed.'},
  version_conflict: {code: 'conflict', text: 'This lesson version already exists with different content. Schola will not replace it. Nothing was changed.'},
  unsupported_version: {code: 'unsupported_version', text: 'This file uses a newer lesson format than this version of Schola supports. Nothing was changed.'},
  revision_conflict: {code: 'revision_conflict', text: 'Your lessons changed since you opened this screen. Reload your lessons and try again.'},
  revision_limit: {code: 'revision_limit', text: 'Your lessons have reached the most changes Schola can record. Nothing was changed.'},
  payload_too_large: {code: 'too_large', text: 'This file is too large. Lesson files and lesson backups may be up to 5 MB. Nothing was changed.'},
  store_full: {code: 'store_full', text: 'Your lesson library is full. Schola keeps it small enough to back up. Nothing was changed.'},
  confirmation_required: {code: 'confirmation_required', text: 'Confirm the switch before Schola changes the version you use.'},
  expected_revision_required: {code: 'expected_revision_required', text: 'Reload your lessons before you switch. Schola needs their current revision.'},
  identity_collision: {code: 'identity_collision', text: 'Two of your existing lessons would get the same name. Schola stopped. Nothing was changed.'},
  not_migrated: {code: 'not_migrated', text: 'Your existing curricula are not prepared for lessons yet. Nothing was changed.'},
  rollback_incomplete: {code: 'rollback_incomplete', text: 'A save failed and Schola could not fully undo it. Check your lessons before you try again.'},
  partial_restore: {code: 'partial_restore', text: 'A restore stopped part way. Check your files before you try again.'},
  newer_than_snapshot: {code: 'newer_than_snapshot', text: 'Some records hold work saved after the migration. Schola did not replace them.'},
  corrupt_file: {code: 'corrupt_file', text: 'A saved lesson file is damaged. Schola kept it as it was. Nothing was changed.'},
  unsafe_path: {code: 'unsafe_path', text: 'Schola found an unsafe path in your data folder and stopped. Nothing was changed.'},
  not_found: {code: 'not_found', text: 'Schola could not find that lesson or version.'},
  storage_unavailable: {code: 'storage_unavailable', text: 'Schola cannot reach its data folder. Check that the folder is writable, then try again.'},
  request_timeout: {code: 'request_timeout', text: 'The request took too long to arrive. Try again.'},
  internal_error: {code: 'internal_error', text: 'Schola hit an unexpected problem. Check your lessons before you try again.'},
  forbidden_origin: {code: 'forbidden_origin', text: 'Open Schola from its own local address.'},
};
/** The codes that mean the request itself was wrong. They need no special words. */
const PLAIN_REQUEST_CODES = new Set(['invalid_request', 'invalid_json', 'unsupported_media_type']);

/** Server text is untrusted. Strip control and invisible characters, then cap the length. @param {unknown} value */
function cleanDetail(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, DETAIL_LIMIT);
}

/** A failed lesson request. The message is fixed text; the server's words stay in `detail`. */
export class LessonServiceError extends Error {
  /** @param {number} status @param {LessonErrorCode} code @param {string} message @param {string} [detail] @param {string} [serverCode] */
  constructor(status, code, message, detail = '', serverCode = '') {
    super(message);
    this.name = 'LessonServiceError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.serverCode = serverCode;
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The lesson routes of the local server. The transport is injected so tests can fake it.
 * Every call stays on this origin and sends no credentials.
 * @param {typeof fetch} [transport]
 * @returns {LessonService}
 */
export function createLessonService(transport = globalThis.fetch.bind(globalThis)) {
  /** @param {string} path @param {{method?:string, body?:unknown}} [options] @returns {Promise<Record<string, any>>} */
  async function request(path, {method = 'GET', body} = {}) {
    /** @type {RequestInit} */
    const init = {method, credentials: 'omit'};
    if (body !== undefined) {
      const text = JSON.stringify(body);
      // Check the whole request before it leaves. The server would refuse it, and the student should learn that at once.
      if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) throw new LessonServiceError(0, 'too_large', TOO_LARGE_TEXT);
      init.headers = {'Content-Type': 'application/json'}; init.body = text;
    }
    let response;
    try { response = await transport(path, init); }
    catch { throw new LessonServiceError(0, 'network_error', 'The local server did not answer. Check your lessons before you try again.'); }
    let value;
    try { value = await response.json(); } catch { value = undefined; }
    if (!response.ok) {
      const detail = cleanDetail(isObject(value) ? value.error : '');
      const serverCode = isObject(value) && typeof value.code === 'string' && /^[a-z][a-z_]{0,39}$/.test(value.code) ? value.code : '';
      /** @type {{code: LessonErrorCode, text: string}} */
      let known;
      if (serverCode && Object.hasOwn(CODE_TEXT, serverCode)) known = CODE_TEXT[serverCode];
      else if (serverCode && PLAIN_REQUEST_CODES.has(serverCode)) known = {code: 'request_failed', text: GENERIC_TEXT};
      else if (serverCode) known = {code: 'request_failed', text: `The local server could not finish this request (code: ${serverCode}).`};
      else if (response.status === 413) known = CODE_TEXT.payload_too_large;
      else known = {code: 'request_failed', text: GENERIC_TEXT};
      throw new LessonServiceError(response.status, known.code, known.text, detail, serverCode);
    }
    if (!isObject(value)) throw new LessonServiceError(response.status, 'invalid_response', 'The local server sent an answer Schola could not read. Check your lessons before you try again.');
    return value;
  }
  /** @param {Record<string, any>} value @returns {Record<string, any>} */
  const withModules = value => {
    if (!Array.isArray(value.modules)) throw new LessonServiceError(200, 'invalid_response', 'The local server sent an answer Schola could not read. Check your lessons before you try again.');
    return value;
  };
  /** The server takes text, one parsed object, or a list. A name is optional. @param {LessonSource} sourceValue @param {string} [filename] */
  const sourceBody = (sourceValue, filename) => ({source: sourceValue, ...(filename === undefined ? {} : {filename})});
  return {
    previewImport: async (sourceValue, filename) => /** @type {LessonPreview} */(withModules(await request(ROUTES.preview, {method: 'POST', body: sourceBody(sourceValue, filename)}))),
    importLessons: async (sourceValue, filename) => /** @type {LessonImportResult} */(await request(ROUTES.import, {method: 'POST', body: sourceBody(sourceValue, filename)})),
    listLessons: async () => /** @type {LessonListing} */(withModules(await request(ROUTES.list))),
    switchPin: async (moduleId, version, options) => {
      if (!options || options.confirm !== true) throw new LessonServiceError(0, 'confirmation_required', 'Confirm the switch before Schola changes the version you use.');
      if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) throw new LessonServiceError(0, 'expected_revision_required', 'Reload your lessons before you switch. Schola needs their current revision.');
      /** @type {PinSwitchRequest} */
      const body = {moduleId, version, confirm: true, expectedRevision: options.expectedRevision};
      return /** @type {LessonListing} */(await request(ROUTES.pins, {method: 'POST', body}));
    },
    exportLessons: async () => await request(ROUTES.export),
    migrate: async () => /** @type {LessonMigration} */(await request(ROUTES.migrate, {method: 'POST', body: {}})),
    previewRestore: async (backup, filename) => /** @type {LessonPreview} */(withModules(await request(ROUTES.preview, {method: 'POST', body: sourceBody(backup, filename)}))),
    restoreBackup: async (backup, filename) => /** @type {LessonImportResult} */(await request(ROUTES.import, {method: 'POST', body: sourceBody(backup, filename)})),
  };
}
