import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationStore } from '../src/stores/automation-store';
import { applySessionInputOwnership, getSessionInputOwnership } from '../src/lib/automation/client-state';
import { automationFixture, ownershipFixture } from './fixtures/automation';

test('pause accepts draining and never grants input from an HTTP response', async () => {
  applySessionInputOwnership(ownershipFixture());
  const requests: { url: string; body: unknown }[] = [];
  const store = createAutomationStore({ sessionId: 'session-1' }, async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === 'POST') return Response.json({ automation: { ...automationFixture(), state: 'paused' }, inputOwnership: { ...ownershipFixture(), mode: 'draining' }, inFlightRunId: 'run-1' }, { status: 202 });
    return Response.json({ items: [{ ...automationFixture(), state: 'paused' }], nextCursor: null });
  });
  assert.equal(await store.getState().pause('rule-1'), true);
  assert.deepEqual(requests[0], { url: '/api/automations/rule-1/state', body: { action: 'pause' } });
  assert.equal(store.getState().items[0].state, 'paused');
  assert.equal(getSessionInputOwnership('session-1').mode, 'armed');
});

test('a stale enable is not retried and refreshes the current revision with a visible conflict', async () => {
  let enables = 0;
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => {
    if (init?.method === 'POST') {
      enables++;
      assert.deepEqual(JSON.parse(String(init.body)), { action: 'enable', expectedRevision: 1 });
      return Response.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed in another window.' } }, { status: 409 });
    }
    return Response.json({ items: [{ ...automationFixture(), revision: 3 }], nextCursor: null });
  });
  assert.equal(await store.getState().enable(automationFixture()), false);
  assert.equal(enables, 1);
  assert.equal(store.getState().items[0].revision, 3);
  assert.equal(store.getState().error, 'REVISION_CONFLICT');
});

test('an uncertain create retains its idempotency key on retry and refetches replayed state', async () => {
  const keys: string[] = [];
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => {
    if (init?.method === 'POST') {
      keys.push(new Headers(init.headers).get('Idempotency-Key')!);
      if (keys.length === 1) throw new Error('connection lost');
      return Response.json({ automation: automationFixture(), inputOwnership: null }, { status: 201 });
    }
    return Response.json({ items: [{ ...automationFixture(), revision: 5 }], nextCursor: null });
  });
  const { wakeInput } = await import('./fixtures/automation');
  assert.equal(await store.getState().save(wakeInput()), false);
  assert.equal(store.getState().error, 'NETWORK_ERROR');
  assert.equal(await store.getState().save(wakeInput()), true);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assert.equal(store.getState().items[0].revision, 5);
});

test('deleted history stays inspectable and unknown recovery acknowledges without resending', async () => {
  const { runFixture } = await import('./fixtures/automation');
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const deleted = { ...automationFixture(), state: 'deleted', revision: 2 };
  const store = createAutomationStore({ sessionId: 'session-1' }, async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith('/resolve')) return Response.json({ automation: deleted, inputOwnership: null, run: { ...runFixture(), state: 'unknown' } });
    if (String(url).includes('/runs')) return Response.json({ items: [{ ...runFixture(), state: 'unknown' }], nextCursor: null });
    if (init?.method === 'DELETE') return Response.json({ automation: deleted, inputOwnership: { ...ownershipFixture(), mode: 'recovery-required' } });
    return Response.json({ items: [deleted], nextCursor: null });
  });
  await store.getState().remove('rule-1');
  await store.getState().loadRuns('rule-1');
  assert.equal(store.getState().runs['rule-1'].items[0].state, 'unknown');
  await store.getState().resolve('rule-1', 'run-1');
  assert.ok(calls.some(c => c.url.includes('includeDeleted=true')));
  assert.deepEqual(calls.find(c => c.url.endsWith('/resolve'))?.body, { resolution: 'acknowledge-no-retry' });
  assert.equal(store.getState().items[0].state, 'deleted');
});

test('unavailable adapter is a visible error and a late list cannot roll back a newer refresh', async () => {
  let release!: (r: Response) => void;
  let count = 0;
  const store = createAutomationStore({ worktreeId: 'wt-1' }, async () => {
    count++;
    if (count === 1) return new Promise<Response>(r => { release = r; });
    if (count === 3) return Response.json({ error: { code: 'RUNTIME_ADAPTER_UNAVAILABLE', message: 'Unavailable' } }, { status: 503 });
    return Response.json({ items: [{ ...automationFixture(), revision: 4 }], nextCursor: null });
  });
  const old = store.getState().refresh();
  await store.getState().refresh();
  release(Response.json({ items: [automationFixture()], nextCursor: null }));
  await old;
  assert.equal(store.getState().items[0].revision, 4);
  await store.getState().refresh();
  assert.equal(store.getState().error, 'RUNTIME_ADAPTER_UNAVAILABLE');
  assert.equal(store.getState().items[0].revision, 4);
});

test('edit sends disabled input and the viewed revision; HTTP failures remain actionable', async () => {
  const { wakeInput } = await import('./fixtures/automation');
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => {
    if (init?.method === 'PUT') {
      assert.deepEqual(JSON.parse(String(init.body)), { expectedRevision: 1, input: { ...wakeInput(), enabled: false } });
      return Response.json({ error: { code: 'PAUSE_REQUIRED', message: 'Pause first' } }, { status: 409 });
    }
    if (init?.method === 'DELETE') throw new Error('offline');
    return Response.json({ items: [automationFixture()], nextCursor: null });
  });
  assert.equal(await store.getState().save({ ...wakeInput(), enabled: true }, automationFixture()), false);
  assert.equal(store.getState().error, 'PAUSE_REQUIRED');
  assert.equal(await store.getState().remove('rule-1'), false);
  assert.equal(store.getState().error, 'NETWORK_ERROR');
});

test('history supports the next page without losing previous runs', async () => {
  const { runFixture } = await import('./fixtures/automation');
  const store = createAutomationStore({ worktreeId: 'wt-1' }, async url => {
    if (String(url).includes('cursor=page-2')) return Response.json({ items: [{ ...runFixture(), id: 'older' }], nextCursor: null });
    return Response.json({ items: [runFixture()], nextCursor: 'page-2' });
  });
  await store.getState().loadRuns('rule-1');
  await store.getState().loadRuns('rule-1', true);
  assert.deepEqual(store.getState().runs['rule-1'].items.map(run => run.id), ['run-1', 'older']);
  await store.getState().loadRuns('rule-1');
  assert.deepEqual(store.getState().runs['rule-1'].items.map(run => run.id), ['run-1', 'older']);
});

test('edit inspection exposes an unresolved attempt before opening the form', async () => {
  const store = createAutomationStore({ sessionId: 'session-1' }, async () => Response.json({ automation: automationFixture(), inputOwnership: { ...ownershipFixture(), mode: 'draining' }, inFlightRunId: 'run-1' }));
  const current = await store.getState().inspect('rule-1');
  assert.equal(current?.inputOwnership?.mode, 'draining');
  assert.equal(current?.inFlightRunId, 'run-1');
});
