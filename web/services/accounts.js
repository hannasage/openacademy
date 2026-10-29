/**
 * The account/learning seam is independent of a renderer or authentication SDK.
 * The legacy window.touchline object remains a facade for the current sync view.
 * @typedef {Window['touchline']} AccountOperations
 */
export function createAccountBridge() {
  /** @type {AccountOperations | undefined} */ let operations;
  const current = () => {
    if (!operations) throw new Error('The learning workspace is not ready.');
    return operations;
  };
  /** @type {AccountOperations} */
  const service = {
    snapshot: async () => current().snapshot(),
    importCloud: async (backup, origin) => current().importCloud(backup, origin),
    setAccountScope: async origin => current().setAccountScope(origin),
    invalidateAccountScope: async () => current().invalidateAccountScope(),
    download: (value, name) => current().download(value, name),
  };
  return {
    service: Object.freeze(service),
    /** @param {AccountOperations} value */
    bind(value) { operations = value; },
  };
}
export const accounts = createAccountBridge();
