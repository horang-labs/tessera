import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { startDevServer } from './helpers/dev-server.mjs';

const app = await startDevServer({
  dataDirPrefix: 'tessera-web-push-e2e-',
  seed: (dataDir) => fs.writeFile(path.join(dataDir, 'mobile-access.json'), JSON.stringify({
    schemaVersion: 1,
    owner: 'tessera.mobile-access',
    nodeDnsName: 'push.test.ts.net',
    origin: 'https://push.test.ts.net',
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: 'http://127.0.0.1:32123',
  }), { mode: 0o600 }),
});
const browser = await launchPhoneBrowser();
const artifacts = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.homedir(), 'tmp', 'tessera-web-push-e2e');
await fs.mkdir(artifacts, { recursive: true });

const appHeaders = {
  'content-type': 'application/json',
  'x-tessera-app-secret': app.appSecret,
  origin: app.origin,
};

async function pairDevice() {
  const configured = await fetch(`${app.origin}/api/settings`, {
    method: 'PUT', headers: appHeaders,
    body: JSON.stringify({
      setup: { completedAt: '2026-08-09T00:00:00.000Z', dismissedAt: null },
      machineSettings: { advertisedAddress: app.origin },
    }),
  });
  assert.equal(configured.status, 200, await configured.text());
  const issued = await fetch(`${app.origin}/api/pairing`, { method: 'POST', headers: appHeaders });
  const issuedBody = await issued.text();
  assert.equal(issued.status, 201, issuedBody);
  const link = JSON.parse(issuedBody).pairingLink;
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('t');
  const claimResponse = await fetch(`${app.origin}/api/pairing/requests`, {
    method: 'POST', headers: { ...appHeaders, 'x-tessera-remote-address': '127.0.0.1' },
    body: JSON.stringify({ token, name: 'Push test phone' }),
  });
  const claim = await claimResponse.json();
  const pending = /pairing_pending=([^;]+)/.exec(claimResponse.headers.get('set-cookie') ?? '')?.[1];
  await fetch(`${app.origin}/api/pairing/requests/${claim.request.id}`, {
    method: 'PATCH', headers: appHeaders, body: JSON.stringify({ decision: 'approve' }),
  });
  const redeemed = await fetch(`${app.origin}/api/pairing/requests/${claim.request.id}`, {
    method: 'POST', headers: { ...appHeaders, cookie: `pairing_pending=${pending}` },
  });
  return /device=([^;]+)/.exec(redeemed.headers.get('set-cookie') ?? '')?.[1];
}

try {
  const deviceToken = await pairDevice();
  assert.ok(deviceToken);
  const installed = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installed.addCookies([{
    name: 'device', value: deviceToken, domain: '127.0.0.1', path: '/', sameSite: 'Strict',
  }]);
  await installed.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === '(display-mode: standalone)'
      ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
      : nativeMatchMedia(query);
    window.__pushPermissionCalls = 0;
    Notification.requestPermission = async () => {
      window.__pushPermissionCalls += 1;
      return 'denied';
    };
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
  });
  const page = await installed.newPage();
  await page.goto(`${app.origin}/chat`);
  await page.getByTestId('chat-layout').waitFor();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-nav-remote-access').click();
  await page.getByTestId('push-device-enable').waitFor();
  assert.equal(await page.evaluate(() => window.__pushPermissionCalls), 0);
  assert.equal(await page.getByTestId('push-global-enabled').isChecked(), true);
  await page.getByTestId('push-device-enable').click();
  assert.equal(await page.evaluate(() => window.__pushPermissionCalls), 1);
  await page.getByTestId('push-device-denied').waitFor();
  assert.equal(await page.getByTestId('chat-layout').isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'permission-denied.png'), fullPage: true });
  await installed.close();

  const background = await browser.newContext({
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  await background.grantPermissions(['notifications'], { origin: app.origin });
  const backgroundPage = await background.newPage();
  await backgroundPage.goto(`${app.origin}/chat`);
  await backgroundPage.evaluate(() => navigator.serviceWorker.ready.then((ready) => ready.scope));
  const worker = background.serviceWorkers()[0];
  assert.ok(worker);
  await backgroundPage.close();
  await worker.evaluate((payload) => {
    self.dispatchEvent(new PushEvent('push', { data: JSON.stringify(payload) }));
  }, {
      kind: 'completed', title: 'Task completed.', preview: 'Background result',
      eventId: 'event-background', sessionId: 'session-1',
      url: '/chat?session=session-1&prompt=tool-1',
  });

  const notificationPage = await background.newPage();
  await notificationPage.goto(`${app.origin}/chat`);
  const notifications = await notificationPage.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map((notification) => ({
      title: notification.title, body: notification.body, data: notification.data,
    }));
  });
  assert.deepEqual(notifications, [{
    title: 'Task completed.', body: 'Background result',
    data: { url: `${app.origin}/chat?session=session-1&prompt=tool-1` },
  }]);
  await worker.evaluate(async () => {
    const [notification] = await registration.getNotifications();
    self.dispatchEvent(new NotificationEvent('notificationclick', { notification }));
  });
  await notificationPage.waitForURL(`${app.origin}/chat?session=session-1&prompt=tool-1`);
  await background.close();

  console.log(JSON.stringify({ permissionCallsBeforeAction: 0, deniedKeepsAppUsable: true,
    backgroundNotificationCount: 1,
    clickUrl: `${app.origin}/chat?session=session-1&prompt=tool-1` }, null, 2));
} finally {
  await browser.close();
  await app.stop();
}
