import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalBackendOrigin, legacyAccountScope} from '../web/account-scope.js';

const account = '0bdb7cc4-f92d-4ac7-84b7-49928d888f2c';
test('legacy scopes use a stable URL UUID and normalize origins and accounts', async () => {
  const scope = await legacyAccountScope('https://EXAMPLE.supabase.co:443/', account.toUpperCase());
  assert.deepEqual(scope, {
    kind: 'cloud', hubId: '5f1a10e2-8270-5f0c-a408-2a87c5c1390f',
    backendOrigin: 'https://example.supabase.co', accountId: account,
  });
  assert.deepEqual(scope, await legacyAccountScope('https://example.supabase.co', account));
  assert.notDeepEqual(scope, await legacyAccountScope('https://example.supabase.co', 'fa057912-c6e0-4d07-87bb-34973675f9ca'));
  assert.notEqual(scope.hubId, (await legacyAccountScope('https://another.supabase.co', account)).hubId);
});
test('backend scope rejects paths, credentials, HTTP, query strings, and fragments', () => {
  for (const url of ['http://example.supabase.co', 'https://user:pass@example.supabase.co',
    'https://example.supabase.co/rest/v1', 'https://example.supabase.co?token=secret',
    'https://example.supabase.co#fragment', 'not a URL']) {
    assert.throws(() => canonicalBackendOrigin(url));
  }
});
test('an invalid account cannot select cached records', async () => {
  await assert.rejects(legacyAccountScope('https://example.supabase.co', '../other'));
  await assert.rejects(legacyAccountScope('https://example.supabase.co', ''));
});
