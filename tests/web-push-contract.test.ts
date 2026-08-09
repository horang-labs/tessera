import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
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
    listSubscriptions: async () => [subscription],
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
      endpoint: 'https://push.example.test/terminal', expirationTime: null,
      keys: { p256dh: 'public', auth: 'auth' },
    }],
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
      endpoint: 'https://push.example.test/first', expirationTime: null,
      keys: { p256dh: 'public', auth: 'auth' },
    }],
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
      endpoint: 'https://push.example.test/fail', expirationTime: null,
      keys: { p256dh: 'public', auth: 'auth' },
    }],
    sendNotification: async () => { sends += 1; throw new Error('offline'); },
  });
  assert.doesNotThrow(() => failing('user-1', {
    type: 'notification', sessionId: 's1', event: 'completed', eventId: 'event-3', message: 'done', preview: '',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
});
