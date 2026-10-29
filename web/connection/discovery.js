const DISCOVERY_PATH = "/.well-known/touchline.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** @param {string} value */
function hubOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Use the HTTPS hub address without a path, password, query, or fragment.");
  // This is the P02 hub-description origin grammar; contract fixtures test parity.
  if(!/^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::(?!443$)[1-9][0-9]{0,4})?$/.test(url.origin)) throw Error('The hub address is not supported.');
  return url.origin;
}
/** @param {unknown} value @param {string[]} keys @returns {Record<string, unknown>} */
function fields(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k))) throw Error("The hub description contains missing or unsupported fields.");
  return /** @type {Record<string, unknown>} */(value);
}
/** @param {unknown} value @param {string} [expectedOrigin] @returns {import("./types").Hub} */
function validateHub(value, expectedOrigin) {
  const h = fields(value, ["format", "version", "hubId", "name", "hubOrigin", "backend", "contracts", "auth"]);
  if (h.format !== "touchline-hub" || h.version !== 1 || typeof h.hubId !== "string" || !uuid.test(h.hubId) || typeof h.name !== "string" || !h.name.trim() || h.name.length > 200) throw Error("This hub identity or version is not supported.");
  if (typeof h.hubOrigin !== "string" || hubOrigin(h.hubOrigin) !== h.hubOrigin || expectedOrigin && h.hubOrigin !== expectedOrigin) throw Error("The hub address does not match its description.");
  const b = fields(h.backend, ["type", "url", "publishableKey"]);
  if (b.type !== "supabase" || typeof b.url !== "string" || hubOrigin(b.url) !== b.url || typeof b.publishableKey !== "string") throw Error("The hub backend is invalid.");
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(b.publishableKey)) {
    try {
      if (!/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(b.publishableKey)) throw Error();
      const claims = JSON.parse(atob(b.publishableKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (claims.role !== "anon") throw Error();
    } catch {
      throw Error("A hub description can contain only a publishable or legacy anon key.");
    }
  }
  const c = fields(h.contracts, ["snapshot", "progress"]);
  if (c.snapshot !== 1 || c.progress !== 1) throw Error("This hub uses an unsupported learning format.");
  const a = fields(h.auth, ["email", "providers"]);
  if (a.email !== "otp" || !Array.isArray(a.providers) || a.providers.length > 2 || new Set(a.providers).size !== a.providers.length || a.providers.some((p) => p !== "google" && p !== "apple")) throw Error("This hub offers an unsupported sign-in method.");
  return /** @type {import("./types").Hub} */(structuredClone(value));
}
/** @param {string} address @param {typeof fetch} [request] */
async function discoverHub(address, request = fetch) {
  const origin = hubOrigin(address), destination = origin + DISCOVERY_PATH;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15e3);
  try {
    const response = await request(destination, { redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", headers: { Accept: "application/json" }, signal: abort.signal });
    if (!response.ok || response.redirected || response.url && response.url !== destination) throw Error("The hub could not be read at that address. Redirects are not accepted.");
    if (!response.headers.get("content-type")?.split(";")[0].trim().match(/^application\/json$/i)) throw Error("The hub did not return a JSON description.");
    if (Number(response.headers.get("content-length")) > 32768) throw Error("The hub description is too large.");
    const reader = response.body?.getReader();
    if (!reader) throw Error("The hub returned an empty description.");
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 32768) {
          await reader.cancel();
          throw Error("The hub description is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return validateHub(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), origin);
  } finally {
    clearTimeout(timeout);
  }
}
export {
  DISCOVERY_PATH,
  discoverHub,
  hubOrigin,
  uuid,
  validateHub
};
