import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-device-list-e2e-'));
const serverOutput = [];
let server = null;
let browser = null;

function logs() {
  return serverOutput.join('');
}

async function startServer() {
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_CHILD',
    'ELECTRON_RUN_AS_NODE',
    'TESSERA_APP_ROOT',
    'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB',
    '__CFBundleIdentifier',
  ]) {
    delete env[key];
  }

  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 300) serverOutput.shift();
    });
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      const response = await fetch(`${origin}/chat`);
      if (response.status < 500) return;
    } catch {
      // Next is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${logs()}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    if (process.platform === 'win32') server.kill('SIGTERM');
    else process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

try {
  await startServer();
  const appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
  const settingsResponse = await fetch(`${origin}/api/settings`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-tessera-app-secret': appSecret,
    },
    body: JSON.stringify({
      machineSettings: { advertisedAddress: origin },
    }),
  });
  assert.equal(settingsResponse.status, 200, await settingsResponse.text());
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addInitScript(() => {
    window.__pairingRequests = [];
    window.__pairingDecisions = [];
    window.__pairingListFails = false;
    const storage = new Map();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        isElectron: true,
        platform: 'linux',
        supportsTailscaleFirewallConfiguration: false,
        getRemoteAccessAddressCandidates: async () => [],
        createPairingCode: async () => ({
          ok: true,
          pairingLink: `${window.location.origin}/pair#t=${'x'.repeat(43)}`,
          qrDataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }),
        listPairingRequests: async () => {
          if (window.__pairingListFails) {
            return { ok: false, code: 'server-unavailable', error: 'server unavailable' };
          }
          return {
            ok: true,
            requests: window.__pairingRequests.map((request) => ({ ...request })),
          };
        },
        decidePairingRequest: async (requestId, decision) => {
          window.__pairingDecisions.push({ requestId, decision });
          const request = window.__pairingRequests.find((candidate) => candidate.id === requestId);
          if (!request) return { ok: false, code: 'not-found', error: 'not found' };
          request.status = decision === 'approve' ? 'approved' : 'denied';
          return { ok: true, request: { ...request } };
        },
        uiStorageGetItem: (key) => storage.get(key) ?? null,
        uiStorageSetItem: (key, value) => storage.set(key, value),
        uiStorageRemoveItem: (key) => storage.delete(key),
      },
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));
  let devices = [
    {
      id: 'phone-1',
      name: 'Travel phone',
      registeredAt: '2026-08-01T01:02:00.000Z',
      lastSeenAt: '2026-08-04T02:03:00.000Z',
      connected: true,
    },
    {
      id: 'tablet-2',
      name: 'Kitchen tablet',
      registeredAt: '2026-08-02T03:04:00.000Z',
      lastSeenAt: null,
      connected: false,
    },
  ];
  const deleteRequests = [];

  await page.route('**/api/devices**', async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ devices, maxDevices: 2 }),
      });
      return;
    }
    if (request.method() === 'DELETE') {
      deleteRequests.push(requestUrl.pathname);
      if (requestUrl.pathname === '/api/devices') devices = [];
      else devices = devices.filter((device) => requestUrl.pathname !== `/api/devices/${device.id}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, disconnectedConnections: 1 }),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // This test authenticates HTTP with the Electron app header, which browsers
  // cannot attach to WebSocket upgrades. Keep the expected dev-only WS overlay
  // from intercepting otherwise valid settings interactions.
  await page.addStyleTag({ content: 'nextjs-portal { pointer-events: none !important; }' });
  await page.evaluate(() => {
    const removeDevOverlay = () => {
      document.querySelectorAll('nextjs-portal').forEach((portal) => portal.remove());
    };
    removeDevOverlay();
    new MutationObserver(removeDevOverlay).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-nav-remote-access').click();

  await page.getByRole('button', { name: 'Add device' }).click();
  const approvalSection = page.getByTestId('pairing-approval-requests');
  await approvalSection.waitFor();
  assert.equal(await approvalSection.getAttribute('aria-labelledby'), 'pairing-approval-title');
  await page.getByText(/Waiting for another device to scan the pairing code/).waitFor();
  await page.evaluate(() => {
    window.__pairingRequests.push({
      id: 'pending-phone',
      name: 'Travel phone',
      browser: 'Mobile Safari',
      platform: 'iOS',
      remoteAddress: '100.64.0.8',
      comparisonCode: '381204',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      status: 'pending',
    });
  });

  const approvalCard = page.getByTestId('pairing-approval-request-pending-phone');
  await approvalCard.waitFor({ timeout: 15_000 });
  assert.match(await approvalCard.innerText(), /Travel phone/);
  assert.match(await approvalCard.innerText(), /Mobile Safari/);
  assert.match(await approvalCard.innerText(), /iOS/);
  assert.match(await approvalCard.innerText(), /100\.64\.0\.8/);
  assert.match((await approvalCard.innerText()).replaceAll(/\s/g, ''), /381204/);
  const approveButton = page.getByRole('button', { name: 'Approve Travel phone' });
  await approveButton.focus();
  assert.equal(await approveButton.evaluate((button) => document.activeElement === button), true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__pairingDecisions.length === 1, null, {
    timeout: 15_000,
  });
  await approvalCard.getByText('Approved', { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByTestId('pairing-approve-pending-phone').isDisabled(), true);

  await page.evaluate(() => {
    window.__pairingRequests.push({
      id: 'denied-tablet',
      name: 'Unknown tablet',
      browser: 'Chrome',
      platform: 'Android',
      remoteAddress: '100.64.0.9',
      comparisonCode: '719553',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });
  });
  await page.getByRole('button', { name: 'Deny Unknown tablet' }).click();
  assert.match(await page.getByTestId('pairing-approval-request-denied-tablet').innerText(), /Denied/);
  assert.deepEqual(await page.evaluate(() => window.__pairingDecisions), [
    { requestId: 'pending-phone', decision: 'approve' },
    { requestId: 'denied-tablet', decision: 'deny' },
  ]);

  await page.evaluate(() => {
    window.__pairingRequests.push({
      id: 'expired-laptop',
      name: 'Expired laptop',
      browser: 'Firefox',
      platform: 'Linux',
      remoteAddress: '100.64.0.10',
      comparisonCode: '440219',
      createdAt: new Date(Date.now() - 180_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'expired',
    });
  });
  const expiredCard = page.getByTestId('pairing-approval-request-expired-laptop');
  await expiredCard.waitFor({ timeout: 15_000 });
  assert.match(await expiredCard.innerText(), /Expired/);
  assert.equal(await page.getByTestId('pairing-approve-expired-laptop').isDisabled(), true);
  assert.equal(await page.getByTestId('pairing-deny-expired-laptop').isDisabled(), true);

  await page.evaluate(() => { window.__pairingListFails = true; });
  await page.getByRole('alert').filter({ hasText: 'Pending device requests could not be refreshed.' })
    .waitFor({ timeout: 15_000 });
  await page.evaluate(() => { window.__pairingListFails = false; });

  await page.getByTestId('paired-device-phone-1').waitFor({ timeout: 15_000 });
  assert.equal(await page.getByTestId('paired-device-phone-1-status').innerText(), 'Connected now');
  assert.match(await page.getByTestId('paired-device-phone-1').innerText(), /Registered/);
  assert.match(await page.getByTestId('paired-device-phone-1').innerText(), /Last connected/);
  await page.getByTestId('paired-device-capacity').waitFor();

  await page.getByTestId('paired-device-phone-1-disconnect').click();
  await page.getByTestId('paired-device-disconnect-dialog').waitFor();
  await page.getByTestId('paired-device-disconnect-cancel').click();
  assert.deepEqual(deleteRequests, [], 'cancelling must not revoke the device');

  await page.getByTestId('paired-device-phone-1-disconnect').click();
  await page.getByTestId('paired-device-disconnect-confirm').click();
  await page.getByTestId('paired-device-phone-1').waitFor({ state: 'detached' });
  assert.deepEqual(deleteRequests, ['/api/devices/phone-1']);

  await page.getByTestId('paired-device-disable-all').click();
  await page.getByTestId('paired-device-disable-all-confirm').click();
  await page.getByTestId('paired-device-empty').waitFor();
  assert.deepEqual(deleteRequests, ['/api/devices/phone-1', '/api/devices']);

  await context.close();
  console.log(JSON.stringify({
    deviceMetadataVisible: true,
    connectedDeviceVisible: true,
    disconnectConfirmed: true,
    disableAllConfirmed: true,
    emptyStateVisible: true,
    capacityVisible: true,
    pairingApprovalVisible: true,
    pairingDecisionButtonsAccessible: true,
    pairingKeyboardApproval: true,
    pairingExpiredState: true,
    pairingListErrorState: true,
  }, null, 2));
} catch (error) {
  console.error(error);
  console.error(logs());
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const candidate = net.createServer();
    candidate.once('error', reject);
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address();
      candidate.close((error) => {
        if (error) reject(error);
        else if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('failed to reserve an E2E port'));
      });
    });
  });
}
