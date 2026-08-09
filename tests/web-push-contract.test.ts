import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { NextRequest } from 'next/server';
import { pairApprovedDevice } from './helpers/approved-device';

let tempDir: string;
const previousDataDir = process.env.TESSERA_DATA_DIR;
const previousElectronRuntime = process.env.TESSERA_ELECTRON_RUNTIME;
const previousPort = process.env.PORT;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-web-push-'));
  process.env.TESSERA_DATA_DIR = tempDir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.PORT = '32123';
});

beforeEach(async () => {
  const { clearDeviceRegistry } = await import('../src/lib/auth/device-registry');
  await clearDeviceRegistry();
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
  else process.env.TESSERA_DATA_DIR = previousDataDir;
  if (previousElectronRuntime === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME;
  else process.env.TESSERA_ELECTRON_RUNTIME = previousElectronRuntime;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await rm(tempDir, { recursive: true, force: true });
});

test('one installation atomically persists one owner-only VAPID identity', async () => {
  const { ensureVapidIdentity, getVapidIdentityPath } = await import('../src/lib/push/vapid-identity');

  const [first, concurrent] = await Promise.all([
    ensureVapidIdentity(),
    ensureVapidIdentity(),
  ]);
  const reloaded = await ensureVapidIdentity();

  assert.deepEqual(concurrent, first);
  assert.deepEqual(reloaded, first);
  assert.match(first.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.match(first.privateKey, /^[A-Za-z0-9_-]+$/);
  assert.equal((await stat(getVapidIdentityPath())).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(getVapidIdentityPath()))).mode & 0o777, 0o700);
});

test('Windows VAPID persistence applies current-user ACLs before atomic publication', async () => {
  const { FileVapidIdentityStore } = await import('../src/lib/push/vapid-identity');
  const identityPath = path.join(tempDir, 'windows-vapid', 'vapid-identity.json');
  const protectedPaths: Array<{ targetPath: string; directory: boolean }> = [];
  const identityStore = new FileVapidIdentityStore(identityPath, {
    platform: 'win32',
    async restrictWindowsPath(targetPath, directory) {
      protectedPaths.push({ targetPath, directory });
    },
  });

  await identityStore.ensure();

  assert.deepEqual(protectedPaths.map(({ directory }) => directory), [true, false, false]);
  assert.equal(protectedPaths[0]?.targetPath, path.dirname(identityPath));
  assert.match(protectedPaths[1]?.targetPath ?? '', /\.vapid-identity\..+\.tmp$/);
  assert.equal(protectedPaths[2]?.targetPath, identityPath);
});

test('a paired device can replace, read, and delete only its own subscription', async () => {
  const first = await pairApprovedDevice('First phone');
  const second = await pairApprovedDevice('Second phone');
  const route = await import('../src/app/api/push/subscription/route');
  const subscription = {
    endpoint: 'https://push.example.test/first',
    expirationTime: null,
    keys: { p256dh: 'BEl6dGVzdC1wdWJsaWMta2V5', auth: 'dGVzdC1hdXRo' },
  };
  const headers = {
    cookie: `device=${first.device.token}`,
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
    'content-type': 'application/json',
  };

  const created = await route.PUT(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...subscription, deviceId: second.device.id }),
    },
  ));
  assert.equal(created.status, 200);

  const own = await route.GET(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    { headers },
  ));
  assert.equal(own.status, 200);
  const ownBody = await own.json();
  assert.deepEqual(ownBody.subscription, subscription);
  assert.match(ownBody.vapidPublicKey, /^[A-Za-z0-9_-]+$/);

  const other = await route.GET(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    {
      headers: {
        ...headers,
        cookie: `device=${second.device.token}`,
      },
    },
  ));
  assert.equal(other.status, 200);
  assert.equal((await other.json()).subscription, null);

  const removed = await route.DELETE(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    { method: 'DELETE', headers },
  ));
  assert.equal(removed.status, 200);
  const afterDelete = await route.GET(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    { headers },
  ));
  assert.equal((await afterDelete.json()).subscription, null);

  const unauthenticated = await route.GET(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    { headers: { host: 'localhost:32123', origin: 'http://localhost:32123' } },
  ));
  assert.equal(unauthenticated.status, 401);
});

test('completed notifications schedule size-limited push without blocking WebSocket delivery', async () => {
  const {
    buildCompletedPushPayload,
    createWebPushDispatcher,
  } = await import('../src/lib/push/web-push-dispatcher');
  const subscription = {
    endpoint: 'https://push.example.test/first',
    expirationTime: null,
    keys: { p256dh: 'public', auth: 'auth' },
  };
  let releasePush!: () => void;
  const pendingPush = new Promise<void>((resolve) => { releasePush = resolve; });
  const sent: string[] = [];
  const dispatch = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [subscription],
    sendNotification: async (_subscription, payload) => {
      sent.push(payload);
      await pendingPush;
    },
  });

  const result = dispatch('user-1', {
    type: 'notification',
    sessionId: 'session / 1',
    event: 'completed',
    message: 'Task completed.',
    preview: 'x'.repeat(20_000),
  });

  assert.equal(result, undefined, 'the send-to-user seam must remain synchronous');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, 'push starts in the background');
  const payload = JSON.parse(sent[0]);
  assert.equal(payload.kind, 'completed');
  assert.equal(payload.url, '/chat?session=session+%2F+1');
  assert.ok(Buffer.byteLength(sent[0], 'utf8') <= 2_048);
  releasePush();

  const fallback = buildCompletedPushPayload({
    type: 'notification',
    sessionId: 'session-2',
    event: 'completed',
    message: '',
    preview: '',
  });
  assert.equal(fallback.title, 'Task completed.');
  assert.equal(fallback.preview, 'Your Tessera session completed.');
});

test('the server send-to-user seam classifies push even when no WebSocket is connected', async () => {
  const { WebSocketServer } = await import('../src/lib/ws/server');
  const scheduled: unknown[] = [];
  const server = new WebSocketServer({
    scheduleWebPush: (userId, message) => scheduled.push({ userId, message }),
  });
  const message = {
    type: 'notification' as const,
    sessionId: 'session-1',
    event: 'completed' as const,
    message: 'Task completed.',
    preview: 'Finished cleanly.',
  };

  server.sendToUser('user-1', message);

  assert.deepEqual(scheduled, [{ userId: 'user-1', message }]);
});

test('global suppression, missing subscriptions, and push failures stay best-effort', async () => {
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  let sends = 0;
  const base = {
    listSubscriptions: async () => [],
    sendNotification: async () => { sends += 1; throw new Error('offline'); },
  };
  const disabled = createWebPushDispatcher({
    ...base,
    loadSettings: async () => ({ notifications: { pushEnabled: false } }),
  });
  const missing = createWebPushDispatcher({
    ...base,
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
  });

  disabled('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', message: 'done', preview: '',
  });
  missing('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', message: 'done', preview: '',
  });
  missing('user-1', {
    type: 'notification', sessionId: 's1', event: 'input_required', message: 'input', preview: '',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);

  const failing = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [{
      endpoint: 'https://push.example.test/fail', expirationTime: null,
      keys: { p256dh: 'public', auth: 'auth' },
    }],
    sendNotification: async () => { sends += 1; throw new Error('offline'); },
  });
  assert.doesNotThrow(() => failing('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', message: 'done', preview: '',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
});
