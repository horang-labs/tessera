import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { GET } from '../src/app/sw.js/route';

interface WorkerHarness {
  handlers: Record<string, (event: any) => void>;
  shown: Array<{ title: string; options: Record<string, any> }>;
  clients: Array<Record<string, any>>;
  opened: string[];
}

async function workerHarness(): Promise<WorkerHarness> {
  const handlers: Record<string, (event: any) => void> = {};
  const shown: Array<{ title: string; options: Record<string, any> }> = [];
  const clients: Array<Record<string, any>> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://tessera.example' },
    addEventListener(type: string, handler: (event: any) => void) { handlers[type] = handler; },
    skipWaiting() {},
    clients: {
      claim: async () => undefined,
      matchAll: async () => clients,
      openWindow: async (url: string) => { opened.push(url); },
    },
    registration: {
      showNotification: async (title: string, options: Record<string, any>) => {
        shown.push({ title, options });
      },
    },
  };
  const response = GET();
  vm.runInNewContext(await response.text(), { self, URL });
  return { handlers, shown, clients, opened };
}

async function dispatch(handler: (event: any) => void, event: Record<string, any>) {
  let pending: Promise<unknown> = Promise.resolve();
  handler({ ...event, waitUntil(value: Promise<unknown>) { pending = value; } });
  await pending;
}

test('a background completed push displays exactly one routed notification', async () => {
  const worker = await workerHarness();
  await dispatch(worker.handlers.push, {
    data: { json: () => ({
      kind: 'completed',
      title: 'Task completed.',
      preview: 'All checks passed.',
      sessionId: 'session-1',
      eventId: 'event-1',
      url: '/chat?session=session-1',
    }) },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(worker.shown)), [{
    title: 'Task completed.',
    options: {
      body: 'All checks passed.',
      icon: '/icons/tessera-192.png',
      badge: '/icons/tessera-192.png',
      tag: 'tessera-session-notification-event-1',
      data: { url: 'https://tessera.example/chat?session=session-1' },
    },
  }]);
});

test('a visible Tessera window receives the event without an operating-system notification', async () => {
  const worker = await workerHarness();
  const forwarded: unknown[] = [];
  worker.clients.push({
    visibilityState: 'visible',
    postMessage: (message: unknown) => forwarded.push(message),
  });
  await dispatch(worker.handlers.push, {
    data: { json: () => ({
      kind: 'permission_request', eventId: 'event-visible', sessionId: 's1',
      title: 'Permission requested.', preview: 'Bash is requesting permission to run',
      url: '/chat?session=s1&prompt=tool-1',
    }) },
  });
  assert.equal(worker.shown.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(forwarded)), [{
    type: 'tessera-session-notification',
    notification: {
      kind: 'permission_request', eventId: 'event-visible', sessionId: 's1',
      title: 'Permission requested.', preview: 'Bash is requesting permission to run',
      url: '/chat?session=s1&prompt=tool-1',
    },
  }]);
});

test('all eligible kinds use kind-specific fallbacks and unrelated Push is ignored', async () => {
  const worker = await workerHarness();
  for (const [kind, title, body] of [
    ['completed', 'Task completed.', 'Your Tessera session completed.'],
    ['input_required', 'Input required.', 'Your Tessera session needs input.'],
    ['permission_request', 'Permission requested.', 'A tool is waiting for permission.'],
    ['ask_user_question', 'Question requires your answer.', 'A question is waiting for your answer.'],
    ['plan_approval', 'Plan approval required.', 'A plan is waiting for approval.'],
  ] as const) {
    await dispatch(worker.handlers.push, {
      data: { json: () => ({ kind, eventId: `event-${kind}`, sessionId: 's1' }) },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(worker.shown.at(-1))), {
      title,
      options: {
        body,
        icon: '/icons/tessera-192.png',
        badge: '/icons/tessera-192.png',
        tag: `tessera-session-notification-event-${kind}`,
        data: { url: 'https://tessera.example/chat' },
      },
    });
  }

  const shownBeforeExcluded = worker.shown.length;
  await dispatch(worker.handlers.push, {
    data: { json: () => ({ kind: 'error', eventId: 'event-error', sessionId: 's1' }) },
  });
  await dispatch(worker.handlers.push, { data: null });
  assert.equal(worker.shown.length, shownBeforeExcluded);
});

test('notification click focuses an existing window or opens the same-origin session URL', async () => {
  const existing = await workerHarness();
  let focused = 0;
  let navigated = '';
  existing.clients.push({
    url: 'https://tessera.example/chat',
    navigate: async (url: string) => { navigated = url; },
    focus: async () => { focused += 1; },
  });
  await dispatch(existing.handlers.notificationclick, {
    notification: {
      data: { url: 'https://tessera.example/chat?session=session-1&prompt=tool-1' },
      close() {},
    },
  });
  assert.equal(navigated, 'https://tessera.example/chat?session=session-1&prompt=tool-1');
  assert.equal(focused, 1);
  assert.deepEqual(existing.opened, []);

  const absent = await workerHarness();
  await dispatch(absent.handlers.notificationclick, {
    notification: {
      data: { url: 'https://evil.example/steal' },
      close() {},
    },
  });
  assert.deepEqual(absent.opened, ['https://tessera.example/chat']);
});
