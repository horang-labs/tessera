import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const port = Number(process.env.TESSERA_E2E_PORT ?? 34219);
const origin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-pair-page-e2e-'));
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
    'TESSERA_ELECTRON_AUTH_BYPASS',
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
      const response = await fetch(`${origin}/pair`);
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

async function appRequest(pathname, init = {}) {
  const secret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin,
      'x-tessera-app-secret': secret,
      ...(init.headers ?? {}),
    },
  });
}

async function issuePairingToken() {
  const response = await appRequest('/api/pairing', { method: 'POST' });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const pairingLink = JSON.parse(body).pairingLink;
  const pairingToken = new URLSearchParams(new URL(pairingLink).hash.slice(1)).get('t');
  assert.ok(pairingToken, 'pairing response did not contain a tokenized link');
  return pairingToken;
}

async function prepareCompletedApp() {
  const response = await appRequest('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      setup: { completedAt: '2026-08-04T00:00:00.000Z', dismissedAt: null },
      machineSettings: { advertisedAddress: origin },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
}

async function assertFailureScreen({
  code,
  status,
  title,
  token = 'x'.repeat(43),
  mockResponse = true,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (mockResponse) {
    await page.route('**/api/pairing/redeem', async (route) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ code, error: title }),
      });
    });
  }

  try {
    await page.goto(`${origin}/pair#t=${token}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    assert.equal(new URL(page.url()).hash, '', `${code} left the token in the address bar`);
    const alert = page.getByTestId('pairing-error');
    await alert.waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(await alert.innerText(), new RegExp(title, 'i'));
  } finally {
    await context.close();
  }
}

try {
  await startServer();
  await prepareCompletedApp();
  browser = await chromium.launch({ headless: true });

  const context = await browser.newContext();
  const page = await context.newPage();
  const pairPageAnalyticsRequests = [];
  let addressAtRedemption = null;
  await page.route('**/api/pairing/redeem', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/pairing/redeem')) {
      addressAtRedemption = page.url();
    }
    if (
      request.url().includes('/api/telemetry/')
      || request.url().includes('/ingest')
      || request.url().toLowerCase().includes('posthog')
    ) {
      if (new URL(page.url()).pathname === '/pair') {
        pairPageAnalyticsRequests.push(request.url());
      }
    }
  });

  const pairingToken = await issuePairingToken();
  await page.goto(`${origin}/pair#t=${pairingToken}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForURL(`${origin}/chat`, { timeout: 30_000 });
  assert.ok(addressAtRedemption, 'the pairing page did not call the redemption API');
  assert.equal(new URL(addressAtRedemption).hash, '', 'redemption started before the token was removed');
  assert.deepEqual(pairPageAnalyticsRequests, [], 'the pairing page loaded telemetry');
  assert.match(
    (await context.cookies(origin)).find((cookie) => cookie.name === 'device')?.value ?? '',
    /^[A-Za-z0-9_-]{43}$/,
  );

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForURL(`${origin}/chat`, { timeout: 30_000 });
  await context.close();

  const missingContext = await browser.newContext();
  const missingPage = await missingContext.newPage();
  await missingPage.goto(`${origin}/pair`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await missingPage.getByTestId('pairing-missing-token').waitFor({ timeout: 15_000 });
  await missingContext.close();

  await assertFailureScreen({
    code: 'pairing-expired',
    status: 410,
    title: 'expired',
  });
  await assertFailureScreen({
    code: 'pairing-used',
    status: 409,
    title: 'already been used',
    token: pairingToken,
    mockResponse: false,
  });
  await assertFailureScreen({
    code: 'pairing-invalid',
    status: 401,
    title: "isn't valid",
    mockResponse: false,
  });

  console.log(JSON.stringify({
    origin,
    pairingCompleted: true,
    tokenRemovedBeforeRedemption: true,
    pairPageAnalyticsRequests,
    persistentDeviceCookie: true,
    failureStates: ['missing', 'expired', 'used', 'invalid'],
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
