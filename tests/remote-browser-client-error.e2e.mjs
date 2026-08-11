import assert from 'node:assert/strict';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';
import { startPhoneAppServer } from './helpers/phone-app-server.mjs';

const marker = `remote-phone-error-${Date.now()}`;
const server = await startPhoneAppServer({ name: 'remote-browser-error' });
const browser = await launchPhoneBrowser();

try {
  const context = await createPhoneContext(browser);
  const page = await server.preparePage(context);
  await page.goto(`${server.origin}/chat`);
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((message) => {
    window.setTimeout(() => {
      throw new Error(message);
    }, 0);
  }, marker);

  const deadline = Date.now() + 10_000;
  while (
    Date.now() < deadline
    && !(server.logs().includes('Remote browser client error') && server.logs().includes(marker))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.match(server.logs(), /Remote browser client error/);
  assert.match(server.logs(), new RegExp(marker));
  assert.match(server.logs(), /remote-browser-client-error/);
  console.log('remote browser client error diagnostics: passed');
} finally {
  await browser.close();
  await server.stop();
}
