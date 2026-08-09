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
      url: '/chat?session=session-1',
    }) },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(worker.shown)), [{
    title: 'Task completed.',
    options: {
      body: 'All checks passed.',
      icon: '/icons/tessera-192.png',
      badge: '/icons/tessera-192.png',
      tag: 'tessera-session-completed-session-1',
      data: { url: 'https://tessera.example/chat?session=session-1' },
    },
  }]);
});

test('a visible Tessera window suppresses the redundant operating-system notification', async () => {
  const worker = await workerHarness();
  worker.clients.push({ visibilityState: 'visible' });
  await dispatch(worker.handlers.push, {
    data: { json: () => ({ kind: 'completed', sessionId: 's1' }) },
  });
  assert.equal(worker.shown.length, 0);
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
      data: { url: 'https://tessera.example/chat?session=session-1' },
      close() {},
    },
  });
  assert.equal(navigated, 'https://tessera.example/chat?session=session-1');
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
