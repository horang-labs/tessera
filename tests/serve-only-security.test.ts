import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const SERVE_ORIGIN = 'https://desktop.tailnet.ts.net';
const LOOPBACK_PORT = 32_123;

let tempDir: string;
let previousEnvironment: Record<string, string | undefined>;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-serve-only-'));
  previousEnvironment = Object.fromEntries([
    'TESSERA_DATA_DIR',
    'TESSERA_ELECTRON_RUNTIME',
    'AUTH_KEYS_DIR',
    'USERS_FILE_PATH',
    'PORT',
  ].map((key) => [key, process.env[key]]));
  process.env.TESSERA_DATA_DIR = tempDir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.AUTH_KEYS_DIR = path.join(tempDir, 'auth');
  process.env.USERS_FILE_PATH = path.join(tempDir, 'users.json');
  process.env.PORT = String(LOOPBACK_PORT);

  const { FileMobileAccessStateStore, MOBILE_ACCESS_OWNER } = await import(
    '../src/lib/mobile-access/mobile-access-state-store'
  );
  await new FileMobileAccessStateStore(path.join(tempDir, 'mobile-access.json')).save({
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    nodeDnsName: 'desktop.tailnet.ts.net',
    origin: SERVE_ORIGIN,
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: `http://127.0.0.1:${LOOPBACK_PORT}`,
  });
});

after(async () => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDir, { recursive: true, force: true });
});

test('settings API exposes no manual remote-origin contract', async () => {
  const { NextRequest } = await import('next/server');
  const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
  const { GET, PUT } = await import('../src/app/api/settings/route');
  const secret = await ensureAppSecret();
  const headers = {
    [APP_SECRET_HEADER]: secret,
    'content-type': 'application/json',
    host: `localhost:${LOOPBACK_PORT}`,
    origin: `http://localhost:${LOOPBACK_PORT}`,
  };

  const update = await PUT(new NextRequest(`http://localhost:${LOOPBACK_PORT}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      machineSettings: { advertisedAddress: 'http://100.70.80.90:32123' },
    }),
  }));
  assert.equal(update.status, 200);
  assert.equal('machineSettings' in await update.json(), false);

  const read = await GET(new NextRequest(`http://localhost:${LOOPBACK_PORT}/api/settings`, {
    headers,
  }));
  assert.equal(read.status, 200);
  assert.equal('machineSettings' in await read.json(), false);
  await assert.rejects(access(path.join(tempDir, 'remote-access.json')), { code: 'ENOENT' });
});

test('only the owned Serve HTTPS origin joins the loopback Origin allowlist', async () => {
  const { getAllowedOrigins } = await import('../src/lib/auth/allowed-origins');
  assert.deepEqual([...await getAllowedOrigins()].sort(), [
    `http://127.0.0.1:${LOOPBACK_PORT}`,
    `http://localhost:${LOOPBACK_PORT}`,
    SERVE_ORIGIN,
  ]);
});

test('pairing links use the owned Serve HTTPS origin', async () => {
  const { createPairingPresentation } = await import('../src/lib/auth/pairing-presentation');
  const presentation = await createPairingPresentation('issue');
  assert.match(presentation.pairingLink, /^https:\/\/desktop\.tailnet\.ts\.net\/pair#t=/);
});

test('unauthenticated Serve HTTP and WebSocket traffic remains rejected', async () => {
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const input = {
    method: 'GET',
    rawUrl: '/api/projects',
    host: 'desktop.tailnet.ts.net',
    origin: SERVE_ORIGIN,
    cookies: {},
    headers: {},
  };

  assert.deepEqual(await evaluateRequest({ ...input, purpose: 'http' }), {
    allow: false,
    reason: 'unauthorized',
    status: 401,
  });
  assert.deepEqual(await evaluateRequest({ ...input, purpose: 'ws-upgrade' }), {
    allow: false,
    reason: 'unauthorized',
    wsCloseCode: 1008,
  });
});
