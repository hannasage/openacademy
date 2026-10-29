/** A failed local request, including the server's recovery details. */
export class LearningServiceError extends Error {
  /** @param {number} status @param {Partial<ApiError>} details */
  constructor(status, details) {
    super(details.error || 'The learning record could not be saved.');
    this.name = 'LearningServiceError';
    this.status = status;
    this.code = details.code || 'request_failed';
    this.field = details.field;
    this.retryable = details.retryable === true;
    this.currentRevision = details.currentRevision;
  }
}
/** @param {CloudOrigin | null} [scope] */
function scopeQuery(scope) {
  return scope ? '?' + new URLSearchParams({hubId:scope.hubId, backendOrigin:scope.backendOrigin, accountId:scope.accountId}) : '';
}
/** The transport boundary accepts an injected fetch for isolated tests. @param {typeof fetch} [transport] */
export function createLearningService(transport = globalThis.fetch.bind(globalThis)) {
  /** @template T @param {string} path @param {unknown} [body] @param {string} [method] @returns {Promise<T>} */
  async function request(path, body, method = 'PUT') {
    const response = await transport(path, body === undefined ? {} : {
      method, headers: {'Content-Type':'application/json'}, body:JSON.stringify(body),
    });
    let value;
    try { value = await response.json(); }
    catch { throw new LearningServiceError(response.status, {error:'The local server response could not be read. Keep your work and retry.', code:'invalid_response', retryable:true}); }
    if (!response.ok) throw new LearningServiceError(response.status, value && typeof value === 'object' ? value : {});
    return value;
  }
  return {
    /** @returns {Promise<Array<{recordId:string,title:string,revision:number,damagedDigest:string}>>} */
    recoveryOptions:()=>request('/api/recovery'),
    /** @param {string} recordId @param {string} damagedDigest @returns {Promise<LocalRecord>} */
    recoverRecord:(recordId,damagedDigest)=>request('/api/recovery',{recordId,damagedDigest},'POST'),
    /** @returns {Promise<Curriculum[]>} */
    listCurricula: () => request('/api/curricula'),
    /** @param {Curriculum} curriculum @returns {Promise<Curriculum>} */
    importCurriculum: curriculum => request('/api/curricula', curriculum),
    /** @param {CloudOrigin | null} [scope] @returns {Promise<LibraryResponse>} */
    listLibrary: scope => request('/api/library' + scopeQuery(scope)),
    /** @param {string|null} focusRecordId @param {number} expectedRevision @param {CloudOrigin|null} [scope] @returns {Promise<LibraryResponse>} */
    saveFocus: (focusRecordId,expectedRevision,scope) => request('/api/library'+scopeQuery(scope),{focusRecordId,expectedRevision}),
    /** @param {string} recordId @param {CloudOrigin | null} [scope] @returns {Promise<LocalRecord>} */
    getRecord: (recordId, scope) => request('/api/records/' + encodeURIComponent(recordId) + scopeQuery(scope)),
    /** @param {LocalRecord} record @param {number} expectedRevision @param {CloudOrigin | null} [scope] @returns {Promise<LocalRecord>} */
    saveRecord: (record, expectedRevision, scope) => request('/api/records/' + encodeURIComponent(record.recordId) + scopeQuery(scope), {expectedRevision, record}),
    /** @param {LearningBackup | LocalRecord} source @param {LocalRecordOrigin} origin @param {LibraryStatus} status @param {{targetRecordId:string,expectedRevision:number}} [replacement] @returns {Promise<LocalRecord>} */
    previewImport: (source,origin,status,replacement) => request('/api/import/preview'+scopeQuery(origin.kind==='cloud'?origin:null),{source,origin,status,...replacement},'POST'),
    /** @param {LearningBackup | LocalRecord} source @param {LocalRecordOrigin} origin @param {LibraryStatus} status @param {{targetRecordId:string,expectedRevision:number}} [replacement] @returns {Promise<LocalRecord>} */
    importRecord: (source, origin, status, replacement) => request('/api/import' + scopeQuery(origin.kind === 'cloud' ? origin : null), {source, origin, status, ...replacement}, 'POST'),
  };
}
