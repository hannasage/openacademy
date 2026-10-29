/** @param {string} value */
export function canonicalBackendOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use your HTTPS Supabase project URL without a path, query, or fragment.');
  }
  return url.origin;
}

/**
 * Compatibility identity for connections created before hub discovery.
 * This stable UUID is a cache namespace, not an authentication credential.
 * Discovered hubs use their published hubId instead in the later setup flow.
 * @param {string} backendUrl
 * @param {string} accountId
 * @returns {Promise<CloudOrigin>}
 */
export async function legacyAccountScope(backendUrl, accountId) {
  const backendOrigin = canonicalBackendOrigin(backendUrl);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    throw new Error('The signed-in account has an invalid identifier. Sign in again.');
  }
  // UUID v5 with the standard URL namespace. The backend origin contains no secrets.
  const namespace = Uint8Array.from('6ba7b8119dad11d180b400c04fd430c8'.match(/../g) || [], x => parseInt(x, 16));
  const name = new TextEncoder().encode(backendOrigin);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  const hubId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {kind: 'cloud', hubId, backendOrigin, accountId: accountId.toLowerCase()};
}
