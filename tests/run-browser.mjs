import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createIsolatedServer} from './browser/server.mjs';
import {isolateContext} from './browser/network.mjs';
import {verifyPersistence, verifyStaleWrite} from './browser/persistence.mjs';

import {verifyDrafts, verifyRecordScopes, verifyAccountInvalidation} from './browser/drafts.mjs';

import {verifyLearningScreens,verifyRecoveredStartup,verifyStatusWriterConflict,verifyEditsDuringStatusSave} from './browser/learning-screens.mjs';
import {verifyShell,verifyStartupRecovery} from './browser/shell.mjs';

const server = await createIsolatedServer();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({serviceWorkers: 'block'});
  const externalRequests = await isolateContext(context, server.url);
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await verifyPersistence({page, server});
  await verifyStaleWrite(server);
  await verifyDrafts({page, server});
  await verifyRecordScopes({page, server});
  await verifyAccountInvalidation({page, server});
  await verifyShell({page,server});
  await verifyStartupRecovery({page,server});
  await verifyLearningScreens({page,server});
  await verifyRecoveredStartup({page,server});
  await verifyStatusWriterConflict({page,server});
  await verifyEditsDuringStatusSave({page,server});
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
