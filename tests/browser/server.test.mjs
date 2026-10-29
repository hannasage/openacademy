import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import test from 'node:test';
import {createIsolatedServer} from './server.mjs';

test('the account return serves only the local shell without reflecting or caching its code', async () => {
  const server = await createIsolatedServer();
  try {
    const response = await fetch(`${server.url}/auth/return?code=private-return-code&touchline-return=nonce`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    assert.match(html, /id="app-root"/);
    assert.doesNotMatch(html, /private-return-code/);
    assert.equal((await fetch(`${server.url}/auth/return/other`)).status, 404);
    const foreign = await fetch(`${server.url}/auth/return`, {headers:{Origin:'https://foreign.invalid'}});
    assert.equal(foreign.status, 403);
  } finally { await server.close(); }
});

test('an isolated server persists state across restart without using the application data directory', async () => {
  const server = await createIsolatedServer();
  const directory = server.directory;
  try {
    assert.match(directory, /touchline-browser-/);
    assert.notEqual(new URL(server.url).port, '8765');
    const initial = await (await fetch(`${server.url}/api/state?plan=soccer-ml`)).json();
    const response = await fetch(`${server.url}/api/state?plan=soccer-ml`, {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...initial, weeklyHours: 7}),
    });
    assert.equal(response.status, 200);
    const originalUrl = server.url;
    await server.restart();
    assert.equal(server.url, originalUrl);
    const recovered = await (await fetch(`${server.url}/api/state?plan=soccer-ml`)).json();
    assert.equal(recovered.weeklyHours, 7);
    assert.equal(recovered.revision, 1);
    const record = await (await fetch(`${server.url}/api/record?plan=soccer-ml`)).json();
    assert.equal(JSON.parse(await readFile(`${directory}/records/${record.recordId}/record.json`, 'utf8')).state.weeklyHours, 7);
  } finally {
    await server.close();
  }
  await assert.rejects(access(directory));
});
