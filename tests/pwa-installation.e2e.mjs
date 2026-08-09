import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';
import { startDevServer } from './helpers/dev-server.mjs';

const app = await startDevServer({ dataDirPrefix: 'tessera-pwa-install-data-' });
const browser = await launchPhoneBrowser();
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.homedir(), 'tmp', 'tessera-pwa-installation-e2e');
await fs.mkdir(artifactDir, { recursive: true });

async function openAuthenticatedContext(options = {}) {
  return createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
    ...options,
  });
}

try {
  const context = await openAuthenticatedContext();
  const page = await context.newPage();
  await page.route('**/api/auth/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto(`${app.origin}/install`, { waitUntil: 'domcontentloaded' });

  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
    });
    window.dispatchEvent(event);
  });

  const manifest = await page.evaluate(() => fetch('/manifest.webmanifest').then((response) => response.json()));
  assert.equal(manifest.name, 'Tessera');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/chat');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    assert.equal(await page.evaluate((src) => fetch(src).then((response) => response.ok), icon.src), true);
  }

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, scripts: [ready.active?.scriptURL, ready.waiting?.scriptURL] };
  });
  assert.equal(registration.scope, `${app.origin}/`);
  assert.equal(registration.scripts.some((url) => url?.endsWith('/sw.js')), true);

  await page.getByTestId('pwa-install-ready').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Install Tessera' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Continue in browser' }).isVisible(), true);
  await page.screenshot({ path: path.join(artifactDir, 'install-ready-headless.png'), fullPage: true });

  await page.getByRole('button', { name: 'Install Tessera' }).click();
  await page.getByTestId('pwa-install-dismissed').waitFor();
  assert.match(await page.locator('main').innerText(), /Installation skipped/);
  await page.getByRole('button', { name: 'Continue in browser' }).click();
  await page.waitForURL(`${app.origin}/chat`);
  await page.goto(`${app.origin}/install`);
  await page.waitForURL(`${app.origin}/chat`);

  await page.evaluate(() => fetch('/api/settings', { cache: 'no-store' }));
  assert.deepEqual(await page.evaluate(() => caches.keys()), []);
  await context.close();

  const installedContext = await openAuthenticatedContext();
  await installedContext.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === '(display-mode: standalone)'
      ? { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }
      : original(query);
  });
  const installedPage = await installedContext.newPage();
  await installedPage.goto(`${app.origin}/install`);
  await installedPage.waitForURL(`${app.origin}/chat`);
  await installedContext.close();

  const ios171 = await openAuthenticatedContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1',
  });
  const ios171Page = await ios171.newPage();
  await ios171Page.goto(`${app.origin}/install`);
  await ios171Page.getByTestId('pwa-install-unsupported').waitFor();
  assert.match(await ios171Page.locator('main').innerText(), /iOS or iPadOS 17\.2 or later/);
  await ios171Page.screenshot({ path: path.join(artifactDir, 'ios171-headless.png'), fullPage: true });
  await ios171.close();

  const ios172 = await openAuthenticatedContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1',
  });
  const ios172Page = await ios172.newPage();
  await ios172Page.goto(`${app.origin}/install`);
  await ios172Page.getByTestId('pwa-install-ios').waitFor();
  assert.match(await ios172Page.locator('main').innerText(), /Share button.*Add to Home Screen/s);
  await ios172.close();

  const ipad172 = await openAuthenticatedContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15',
  });
  await ipad172.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  });
  const ipad172Page = await ipad172.newPage();
  await ipad172Page.goto(`${app.origin}/install`);
  await ipad172Page.getByTestId('pwa-install-ios').waitFor();
  await ipad172.close();

  const ios172Chrome = await openAuthenticatedContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 CriOS/128.0 Mobile/15E148 Safari/604.1',
  });
  const ios172ChromePage = await ios172Chrome.newPage();
  await ios172ChromePage.goto(`${app.origin}/install`);
  await ios172ChromePage.getByTestId('pwa-install-unsupported').waitFor();
  assert.match(await ios172ChromePage.locator('main').innerText(), /cannot transfer its private access to Safari/);
  await ios172Chrome.close();

  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(`${app.origin}/install`);
  await desktopPage.getByRole('button', { name: 'Continue in browser' }).waitFor();
  await desktop.close();

  console.log(JSON.stringify({
    manifestIdentity: true,
    serviceWorkerScope: registration.scope,
    optionalInstall: true,
    repeatVisitSkipped: true,
    installedVisitSkipped: true,
    authenticatedCaches: [],
    ios171Unsupported: true,
    ios172Guided: true,
    ipad172Guided: true,
    ios172ChromeUnsupported: true,
    desktopEscapeReachable: true,
  }, null, 2));
} finally {
  await browser.close();
  await app.stop();
}
