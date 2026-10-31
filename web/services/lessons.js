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
/**
 * The server names every failure with a `code`. The web side reads the code first and the status second.
 * @type {Record<string, {code: LessonErrorCode, text: string}>}
 */
const CODE_TEXT = {
  invalid_lesson: {code: 'invalid', text: 'This is not a valid lesson file. Nothing was changed.'},
  missing_module: {code: 'missing_module', text: 'This lesson set names a module that is not in your library or in this import. Nothing was changed.'},
  version_conflict: {code: 'conflict', text: 'This lesson version already exists with different content. Schola will not replace it. Nothing was changed.'},
  unsupported_version: {code: 'unsupported_version', text: 'This file uses a newer lesson format than this version of Schola supports. Nothing was changed.'},
  revision_conflict: {code: 'revision_conflict', text: 'Your lessons changed since you opened this screen. Reload your lessons and try again.'},
  payload_too_large: {code: 'too_large', text: 'This file is too large. The limit is 5 MB.'},
  confirmation_required: {code: 'confirmation_required', text: 'Confirm the switch before Schola changes the version you use.'},
};
/** @type {Record<number, {code: LessonErrorCode, text: string}>} */
const STATUS_TEXT = {
  409: CODE_TEXT.version_conflict,
  413: CODE_TEXT.payload_too_large,
  422: CODE_TEXT.invalid_lesson,
};

/** Server text is untrusted. Strip control and invisible characters, then cap the length. @param {unknown} value */
function cleanDetail(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, DETAIL_LIMIT);
}

/** A failed lesson request. The message is fixed text; the server's words stay in `detail`. */
export class LessonServiceError extends Error {
  /** @param {number} status @param {LessonErrorCode} code @param {string} message @param {string} [detail] */
  constructor(status, code, message, detail = '') {
    super(message);
    this.name = 'LessonServiceError';
    this.status = status;
    this.code = code;
    this.detail = detail;
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
    if (body !== undefined) { init.headers = {'Content-Type': 'application/json'}; init.body = JSON.stringify(body); }
    let response;
    try { response = await transport(path, init); }
    catch { throw new LessonServiceError(0, 'network_error', 'The local server did not answer. Check your lessons before you try again.'); }
    let value;
    try { value = await response.json(); } catch { value = undefined; }
    if (!response.ok) {
      const detail = cleanDetail(isObject(value) ? value.error : '');
      const named = isObject(value) && typeof value.code === 'string' && Object.hasOwn(CODE_TEXT, value.code) ? CODE_TEXT[value.code] : undefined;
      const known = named || STATUS_TEXT[response.status] || {code: /** @type {LessonErrorCode} */('request_failed'), text: GENERIC_TEXT};
      throw new LessonServiceError(response.status, known.code, known.text, detail);
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
      /** @type {PinSwitchRequest} */
      const body = {moduleId, version, confirm: true};
      if (options.expectedRevision !== undefined) body.expectedRevision = options.expectedRevision;
      return /** @type {LessonListing} */(await request(ROUTES.pins, {method: 'POST', body}));
    },
    exportLessons: async () => await request(ROUTES.export),
    migrate: async () => /** @type {LessonMigration} */(await request(ROUTES.migrate, {method: 'POST', body: {}})),
    previewRestore: async (backup, filename) => /** @type {LessonPreview} */(withModules(await request(ROUTES.preview, {method: 'POST', body: sourceBody(backup, filename)}))),
    restoreBackup: async (backup, filename) => /** @type {LessonImportResult} */(await request(ROUTES.import, {method: 'POST', body: sourceBody(backup, filename)})),
  };
}
