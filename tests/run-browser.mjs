import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createIsolatedServer} from './browser/server.mjs';
import {isolateContext} from './browser/network.mjs';
import {verifyPersistence, verifyStaleWrite} from './browser/persistence.mjs';

const server = await createIsolatedServer();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({serviceWorkers: 'block'});
  const externalRequests = await isolateContext(context, server.url);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await verifyPersistence({page, server});
  await verifyStaleWrite(server);
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://touchline-test-egress.invalid/probe'); return false; }
    catch { return true; }
  });
  assert.equal(blocked, true);
  assert.ok(externalRequests.includes('https://touchline-test-egress.invalid'));
  assert.deepEqual(errors, []);
  console.log('PASS: browser requests cannot reach an external backend; private cloud configuration stays suppressed.');
} finally {
  try { await browser?.close(); }
  finally { await server.close(); }
}
