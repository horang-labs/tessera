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
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
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
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
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
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-nav-remote-access').click();

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
