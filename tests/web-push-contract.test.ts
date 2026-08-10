import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { pairApprovedDevice } from './helpers/approved-device';
import { pushApplicationServerKeyMatches } from '../src/lib/push/browser-push';

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
  const { clearDevicePushSubscriptions } = await import(
    '../src/lib/push/device-push-subscription-store'
  );
  await clearDevicePushSubscriptions();
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

test('a fresh mobile setup rejects a browser subscription from the removed VAPID identity', () => {
  const currentKey = new Uint8Array([1, 2, 3, 4]);
  assert.equal(
    pushApplicationServerKeyMatches(new Uint8Array([1, 2, 3, 4]).buffer, currentKey),
    true,
  );
  assert.equal(
    pushApplicationServerKeyMatches(new Uint8Array([4, 3, 2, 1]).buffer, currentKey),
    false,
  );
  assert.equal(pushApplicationServerKeyMatches(null, currentKey), false);
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

  const replacement = {
    ...subscription,
    endpoint: 'https://push.example.test/replaced',
  };
  const replaced = await route.PUT(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(replacement),
    },
  ));
  assert.equal(replaced.status, 200);

  const {
    getDevicePushSubscriptionStorePath,
    listDevicePushSubscriptions,
  } = await import('../src/lib/push/device-push-subscription-store');
  const persisted = JSON.parse(
    await readFile(getDevicePushSubscriptionStorePath(), 'utf8'),
  ) as { subscriptions: Record<string, unknown> };
  assert.equal((await stat(getDevicePushSubscriptionStorePath())).mode & 0o777, 0o600);
  assert.equal(
    (await stat(path.dirname(getDevicePushSubscriptionStorePath()))).mode & 0o777,
    0o700,
  );
  assert.deepEqual(Object.keys(persisted.subscriptions), [first.device.id]);
  assert.deepEqual(persisted.subscriptions[first.device.id], replacement);
  assert.deepEqual(await listDevicePushSubscriptions(), [{
    deviceId: first.device.id,
    subscription: replacement,
  }]);

  const registry = JSON.parse(
    await readFile(path.join(tempDir, 'auth', 'device-registry.json'), 'utf8'),
  ) as { devices: Array<Record<string, unknown>> };
  assert.equal('pushSubscription' in registry.devices[0], false);

  const own = await route.GET(new NextRequest(
    'http://localhost:32123/api/push/subscription',
    { headers },
  ));
  assert.equal(own.status, 200);
  const ownBody = await own.json();
  assert.deepEqual(ownBody.subscription, replacement);
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

test('device list status and revocation keep subscriptions bound to device trust', async () => {
  const first = await pairApprovedDevice('First phone');
  const second = await pairApprovedDevice('Second phone');
  const {
    getDevicePushSubscription,
    listDevicePushSubscriptions,
    replaceDevicePushSubscription,
  } = await import('../src/lib/push/device-push-subscription-store');
  const { revokeAllPairedDevices, revokePairedDevice } = await import(
    '../src/lib/auth/device-revocation'
  );
  const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const devicesRoute = await import('../src/app/api/devices/route');
  const firstSubscription = {
    endpoint: 'https://push.example.test/first', expirationTime: null,
    keys: { p256dh: 'first-public-key', auth: 'first-auth-key' },
  };
  const secondSubscription = {
    endpoint: 'https://push.example.test/second', expirationTime: null,
    keys: { p256dh: 'second-public-key', auth: 'second-auth-key' },
  };
  await replaceDevicePushSubscription(first.device.id, firstSubscription);
  await replaceDevicePushSubscription(second.device.id, secondSubscription);

  const appSecret = await ensureAppSecret();
  const response = await devicesRoute.GET(new NextRequest(
    'http://localhost:32123/api/devices',
    { headers: {
      [APP_SECRET_HEADER]: appSecret,
      host: 'localhost:32123',
      origin: 'http://localhost:32123',
    } },
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as {
    devices: Array<{ id: string; hasPushSubscription: boolean }>;
  };
  assert.deepEqual(body.devices.map(({ id, hasPushSubscription }) => ({
    id,
    hasPushSubscription,
  })), [
    { id: first.device.id, hasPushSubscription: true },
    { id: second.device.id, hasPushSubscription: true },
  ]);

  assert.deepEqual(await revokePairedDevice(first.device.id), {
    revokedDevices: 1,
    disconnectedConnections: 0,
  });
  assert.equal(await getDevicePushSubscription(first.device.id), null);
  assert.deepEqual(
    await evaluateRequest({
      purpose: 'http', method: 'GET', rawUrl: '/api/push/subscription',
      host: 'localhost:32123', origin: 'http://localhost:32123',
      cookies: { device: first.device.token }, headers: {},
    }),
    { allow: false, reason: 'unauthorized', status: 401 },
  );
  assert.equal((await listDevicePushSubscriptions()).length, 1);

  assert.deepEqual(await revokeAllPairedDevices(), {
    revokedDevices: 1,
    disconnectedConnections: 0,
  });
  assert.deepEqual(await listDevicePushSubscriptions(), []);
});

test('only the installation app can invoke complete mobile-access local cleanup', async () => {
  const { device } = await pairApprovedDevice('Removal phone');
  const { replaceDevicePushSubscription, listDevicePushSubscriptions } = await import(
    '../src/lib/push/device-push-subscription-store'
  );
  const { ensureVapidIdentity, getVapidIdentityPath } = await import(
    '../src/lib/push/vapid-identity'
  );
  const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
  const { listDevices } = await import('../src/lib/auth/device-registry');
  const route = await import('../src/app/api/mobile-access/local-state/route');
  await replaceDevicePushSubscription(device.id, {
    endpoint: 'https://push.example.test/removal', expirationTime: null,
    keys: { p256dh: 'removal-public-key', auth: 'removal-auth-key' },
  });
  await ensureVapidIdentity();
  const origin = 'http://localhost:32123';

  const denied = await route.DELETE(new NextRequest(`${origin}/api/mobile-access/local-state`, {
    method: 'DELETE',
    headers: { cookie: `device=${device.token}`, host: 'localhost:32123', origin },
  }));
  assert.equal(denied.status, 403);
  assert.equal((await listDevices()).length, 1);

  const appSecret = await ensureAppSecret();
  const removed = await route.DELETE(new NextRequest(`${origin}/api/mobile-access/local-state`, {
    method: 'DELETE',
    headers: { [APP_SECRET_HEADER]: appSecret, host: 'localhost:32123', origin },
  }));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), {
    success: true,
    revokedDevices: 1,
    disconnectedConnections: 0,
  });
  assert.deepEqual(await listDevices(), []);
  assert.deepEqual(await listDevicePushSubscriptions(), []);
  await assert.rejects(stat(getVapidIdentityPath()), { code: 'ENOENT' });
  const { getPairedDevicePushConfiguration } = await import(
    '../src/lib/auth/paired-device-lifecycle'
  );
  assert.equal(await getPairedDevicePushConfiguration(device.id), null);
  await assert.rejects(stat(getVapidIdentityPath()), { code: 'ENOENT' });
});

test('revocation wins over a Push registration that authenticated before its body arrived', async () => {
  const { device } = await pairApprovedDevice('Racing phone');
  const route = await import('../src/app/api/push/subscription/route');
  const { revokePairedDevice } = await import('../src/lib/auth/device-revocation');
  const { listDevicePushSubscriptions } = await import(
    '../src/lib/push/device-push-subscription-store'
  );
  let releaseBody!: () => void;
  let bodyReadStarted!: () => void;
  const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
  const readingBody = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
  const request = new NextRequest(
    'http://localhost:32123/api/push/subscription',
    {
      method: 'PUT',
      headers: {
        cookie: `device=${device.token}`,
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
        'content-type': 'application/json',
      },
      body: '{}',
    },
  );
  Object.defineProperty(request, 'json', {
    value: async () => {
      bodyReadStarted();
      await bodyGate;
      return {
        endpoint: 'https://push.example.test/race',
        expirationTime: null,
        keys: { p256dh: 'race-public-key', auth: 'race-auth-key' },
      };
    },
  });

  const registration = route.PUT(request);
  await readingBody;
  await revokePairedDevice(device.id);
  releaseBody();

  assert.equal((await registration).status, 404);
  assert.deepEqual(await listDevicePushSubscriptions(), []);
});

test('all five Session Notification kinds schedule one bounded navigation-only Push payload', async () => {
  const {
    buildSessionNotificationPushPayload,
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
    listSubscriptions: async () => [{ deviceId: 'device-1', subscription }],
    deleteSubscription: async () => false,
    sendNotification: async (_subscription, payload) => {
      sent.push(payload);
      await pendingPush;
    },
  });

  const eligible = [
    {
      type: 'notification' as const,
      sessionId: 'session / 1',
      event: 'completed' as const,
      eventId: 'event-completed',
      message: 'Task completed.',
      preview: 'x'.repeat(20_000),
    },
    {
      type: 'notification' as const,
      sessionId: 'session-2',
      event: 'input_required' as const,
      eventId: 'event-input',
      message: '',
      preview: 'The terminal is waiting at a prompt.',
    },
    {
      type: 'interactive_prompt' as const,
      sessionId: 'session-3',
      promptType: 'permission_request' as const,
      eventId: 'event-permission',
      data: { question: '', toolUseId: 'tool-3', toolName: 'Bash' },
    },
    {
      type: 'interactive_prompt' as const,
      sessionId: 'session-4',
      promptType: 'ask_user_question' as const,
      eventId: 'event-question',
      data: {
        question: '',
        toolUseId: 'tool-4',
        questions: [{ question: 'Which database should we use?', header: 'Database', options: [] }],
      },
    },
    {
      type: 'interactive_prompt' as const,
      sessionId: 'session-5',
      promptType: 'plan_approval' as const,
      eventId: 'event-plan',
      data: { question: '', toolUseId: 'tool-5', plan: '# Ship it' },
    },
  ];

  const result = dispatch('user-1', eligible[0]);
  for (const message of eligible.slice(1)) dispatch('user-1', message);

  assert.equal(result, undefined, 'the send-to-user seam must remain synchronous');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 5, 'each eligible kind starts Push in the background');
  const payloads = sent.map((payload) => JSON.parse(payload));
  assert.deepEqual(payloads.map(({ kind }) => kind), [
    'completed',
    'input_required',
    'permission_request',
    'ask_user_question',
    'plan_approval',
  ]);
  assert.deepEqual(payloads.map(({ eventId }) => eventId), eligible.map(({ eventId }) => eventId));
  assert.equal(payloads[0].url, '/chat?session=session+%2F+1');
  assert.equal(payloads[1].preview, 'The terminal is waiting at a prompt.');
  assert.equal(payloads[2].preview, 'Bash is requesting permission to run');
  assert.equal(payloads[3].preview, 'Which database should we use?');
  assert.equal(payloads[4].preview, 'Waiting for plan approval');
  assert.equal(payloads[2].url, '/chat?session=session-3&prompt=tool-3');
  assert.deepEqual(payloads.map(({ title }) => title), [
    'Task completed.',
    'Input required.',
    'Permission requested.',
    'Question requires your answer.',
    'Plan approval required.',
  ]);
  assert.ok(sent.every((payload) => Buffer.byteLength(payload, 'utf8') <= 2_048));
  releasePush();

  const fallback = buildSessionNotificationPushPayload({
    type: 'notification',
    sessionId: 'session-2',
    event: 'completed',
    eventId: 'event-fallback',
    message: '',
    preview: '',
  });
  assert.equal(fallback.title, 'Task completed.');
  assert.equal(fallback.preview, 'Your Tessera session completed.');
});

test('Session Notification Push uses a five-minute TTL with high urgency', async () => {
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  let sentOptions: unknown;
  const dispatch = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [{
      deviceId: 'priority-device',
      subscription: {
        endpoint: 'https://push.example.test/priority', expirationTime: null,
        keys: { p256dh: 'public', auth: 'auth' },
      },
    }],
    deleteSubscription: async () => false,
    sendNotification: async (_subscription, _payload, options) => {
      sentOptions = options;
    },
  });

  dispatch('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-priority',
    message: 'done', preview: '',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sentOptions, { TTL: 300, urgency: 'high' });
});

test('the server send-to-user seam creates or preserves an event ID before fan-out', async () => {
  const { WebSocketServer } = await import('../src/lib/ws/server');
  const scheduled: unknown[] = [];
  const websocketMessages: any[] = [];
  const server = new WebSocketServer({
    scheduleWebPush: (userId, message) => scheduled.push({ userId, message }),
  });
  (server as any).connections.set('user-1', new Set([{
    readyState: WebSocket.OPEN,
    send: (payload: string) => websocketMessages.push(JSON.parse(payload)),
  }]));
  const generated = {
    type: 'notification' as const,
    sessionId: 'session-1',
    event: 'completed' as const,
    message: 'Task completed.',
    preview: 'Finished cleanly.',
  };
  const preserved = {
    type: 'interactive_prompt' as const,
    sessionId: 'session-2',
    promptType: 'plan_approval' as const,
    eventId: 'upstream-event-id',
    data: { question: '', toolUseId: 'prompt-2', plan: 'Plan' },
  };

  server.sendToUser('user-1', generated);
  server.sendToUser('user-1', preserved);

  assert.equal(scheduled.length, 2);
  assert.equal(websocketMessages.length, 2);
  assert.match(websocketMessages[0].eventId, /^[0-9a-f-]{36}$/);
  assert.equal((scheduled[0] as any).message.eventId, websocketMessages[0].eventId);
  assert.equal((scheduled[1] as any).message.eventId, 'upstream-event-id');
  assert.equal(websocketMessages[1].eventId, 'upstream-event-id');
});

test('the server fan-out seam sends cached terminal state without creating a Push event', async () => {
  const { WebSocketServer } = await import('../src/lib/ws/server');
  const scheduled: unknown[] = [];
  const websocketMessages: any[] = [];
  const server = new WebSocketServer({
    scheduleWebPush: (userId, message) => scheduled.push({ userId, message }),
  });
  (server as any).connections.set('user-1', new Set([{
    readyState: WebSocket.OPEN,
    send: (payload: string) => websocketMessages.push(JSON.parse(payload)),
  }]));

  server.sendToUser('user-1', {
    type: 'session_state',
    sessionId: 'terminal-session',
    terminalId: 'terminal-1',
    status: 'input_required',
    hookEvent: 'PermissionRequest',
    preview: 'Cached terminal approval',
    stateAt: 123,
  }, { replay: true });

  assert.equal(scheduled.length, 0);
  assert.equal(websocketMessages.length, 1);
  assert.equal(websocketMessages[0].eventId, undefined);
});

test('terminal runtime restart marks its cached state at the replay-aware fan-out seam', async () => {
  const sharedManagerSource = await readFile(
    new URL('../src/lib/terminal/shared-terminal-manager.ts', import.meta.url),
    'utf8',
  );
  const serverSource = await readFile(
    new URL('../src/lib/ws/server.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    sharedManagerSource,
    /sendToUser\?\.\(userId, lastState, \{ replay: true \}\)/,
  );
  assert.match(
    serverSource,
    /bindTerminalRuntimeSender\(\(userId, message, options\)[\s\S]*this\.sendToUser\(userId, message, options\)/,
  );
});

test('a live terminal input-required state is eligible but its cached copy is not replayed to Push', async () => {
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  const sent: string[] = [];
  const dispatch = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [{
      deviceId: 'terminal-device',
      subscription: {
        endpoint: 'https://push.example.test/terminal', expirationTime: null,
        keys: { p256dh: 'public', auth: 'auth' },
      },
    }],
    deleteSubscription: async () => false,
    sendNotification: async (_subscription, payload) => { sent.push(payload); },
  });
  const state = {
    type: 'session_state' as const,
    sessionId: 'terminal-session',
    terminalId: 'terminal-1',
    status: 'input_required' as const,
    hookEvent: 'PermissionRequest',
    preview: 'Terminal approval required',
    stateAt: 123,
  };

  dispatch('user-1', { ...state, eventId: 'terminal-live-event' });
  dispatch('user-1', state);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]), {
    kind: 'input_required',
    eventId: 'terminal-live-event',
    title: 'Input required.',
    preview: 'Terminal approval required',
    sessionId: 'terminal-session',
    url: '/chat?session=terminal-session',
  });
});

test('non-Session Notification transport and replay messages never schedule Push', async () => {
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  const sent: string[] = [];
  const dispatch = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [{
      deviceId: 'first-device',
      subscription: {
        endpoint: 'https://push.example.test/first', expirationTime: null,
        keys: { p256dh: 'public', auth: 'auth' },
      },
    }],
    deleteSubscription: async () => false,
    sendNotification: async (_subscription, payload) => { sent.push(payload); },
  });
  const excluded = [
    { type: 'error', sessionId: 's1', code: 'failed', message: 'Generic error' },
    { type: 'session_created', sessionId: 's1', status: 'ready', workDir: '/tmp' },
    { type: 'rate_limit_update', providerId: 'claude-code' },
    { type: 'session_list', sessions: [], titleGeneratingSessionIds: [] },
    { type: 'replay_events', sessionId: 's1', events: [] },
    {
      type: 'session_state', sessionId: 's1', terminalId: 'terminal-1',
      status: 'input_required', hookEvent: 'PermissionRequest', stateAt: 123,
    },
    { type: 'message', sessionId: 's1', role: 'assistant', content: 'transport message' },
    {
      type: 'interactive_prompt', sessionId: 's1', promptType: 'input',
      data: { question: 'legacy transient input', toolUseId: 'legacy-1' },
    },
  ];

  for (const message of excluded) dispatch('user-1', message as any);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
});

test('global suppression, missing subscriptions, and push failures stay best-effort', async () => {
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  let sends = 0;
  const base = {
    listSubscriptions: async () => [],
    deleteSubscription: async () => false,
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
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-disabled', message: 'done', preview: '',
  });
  missing('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-1', message: 'done', preview: '',
  });
  missing('user-1', {
    type: 'notification', sessionId: 's1', event: 'input_required', eventId: 'event-2', message: 'input', preview: '',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);

  const failing = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [{
      deviceId: 'device-fail',
      subscription: {
        endpoint: 'https://push.example.test/fail', expirationTime: null,
        keys: { p256dh: 'public', auth: 'auth' },
      },
    }],
    deleteSubscription: async () => false,
    sendNotification: async () => { sends += 1; throw new Error('offline'); },
  });
  assert.doesNotThrow(() => failing('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-3', message: 'done', preview: '',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
});

test('expired and permanently rejected endpoints are deleted while transient failures remain', async () => {
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  const expired = {
    endpoint: 'https://push.example.test/expired',
    expirationTime: Date.now() - 1,
    keys: { p256dh: 'expired-public', auth: 'expired-auth' },
  };
  const rejected = {
    endpoint: 'https://push.example.test/rejected', expirationTime: null,
    keys: { p256dh: 'rejected-public', auth: 'rejected-auth' },
  };
  const transient = {
    endpoint: 'https://push.example.test/transient', expirationTime: null,
    keys: { p256dh: 'transient-public', auth: 'transient-auth' },
  };
  const sent: string[] = [];
  const deleted: Array<{ deviceId: string; endpoint: string }> = [];
  const dispatch = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [
      { deviceId: 'expired-device', subscription: expired },
      { deviceId: 'rejected-device', subscription: rejected },
      { deviceId: 'transient-device', subscription: transient },
    ],
    deleteSubscription: async (deviceId, endpoint) => {
      deleted.push({ deviceId, endpoint });
      return true;
    },
    sendNotification: async (subscription) => {
      sent.push(subscription.endpoint);
      if (subscription.endpoint === rejected.endpoint) {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
      if (subscription.endpoint === transient.endpoint) {
        throw Object.assign(new Error('service unavailable'), { statusCode: 503 });
      }
    },
  });

  dispatch('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-cleanup',
    message: 'done', preview: '',
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent, [rejected.endpoint, transient.endpoint]);
  assert.deepEqual(deleted, [
    { deviceId: 'expired-device', endpoint: expired.endpoint },
    { deviceId: 'rejected-device', endpoint: rejected.endpoint },
  ]);
});

test('a dispatch holds the paired-device lifecycle until notification delivery settles', async () => {
  const { withPairedDeviceLifecycle } = await import(
    '../src/lib/auth/paired-device-lifecycle-lock'
  );
  const { createWebPushDispatcher } = await import('../src/lib/push/web-push-dispatcher');
  let markSendStarted!: () => void;
  let releaseSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const dispatch = createWebPushDispatcher({
    loadSettings: async () => ({ notifications: { pushEnabled: true } }),
    listSubscriptions: async () => [{
      deviceId: 'racing-device',
      subscription: {
        endpoint: 'https://push.example.test/racing', expirationTime: null,
        keys: { p256dh: 'public', auth: 'auth' },
      },
    }],
    deleteSubscription: async () => false,
    sendNotification: async () => {
      markSendStarted();
      await sendGate;
    },
    runWithLifecycle: withPairedDeviceLifecycle,
  });

  dispatch('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-race',
    message: 'done', preview: '',
  });
  await sendStarted;
  let removalEntered = false;
  const removal = withPairedDeviceLifecycle(async () => { removalEntered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(removalEntered, false);

  releaseSend();
  await removal;
  assert.equal(removalEntered, true);
});
