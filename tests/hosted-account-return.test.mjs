import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../hosted/account-return.js', import.meta.url), 'utf8');

test('hosted account return removes parameters without reading or forwarding a code', () => {
  const calls = [];
  const forbidden = () => { throw Error('This page must not access a return parameter or account service.'); };
  const context = {
    history: {replaceState: (...args) => calls.push(args)},
    fetch: forbidden,
    location: new Proxy({}, {get: forbidden}),
    localStorage: new Proxy({}, {get: forbidden}),
    sessionStorage: new Proxy({}, {get: forbidden}),
  };
  runInNewContext(source, context);
  assert.deepEqual(calls, [[null, '', '/auth/return']]);
});

test('blocked history changes give a recovery message without navigation', () => {
  const notice = {textContent: ''};
  runInNewContext(source, {
    history: {replaceState() { throw Error('Blocked by browser'); }},
    document: {getElementById(id) { assert.equal(id, 'return-privacy'); return notice; }},
  });
  assert.match(notice.textContent, /Close this tab/);
  assert.match(notice.textContent, /Touchline app/);
});
