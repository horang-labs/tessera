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

test('pause retains the 202 control receipt for drain presentation without unlocking input', async () => {
  const receipt = { automation: { ...automationFixture(), state: 'paused' }, inputOwnership: { ...ownershipFixture(), mode: 'draining' }, inFlightRunId: 'run-1' };
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => init?.method === 'POST'
    ? Response.json(receipt, { status: 202 }) : Response.json({ items: [receipt.automation], nextCursor: null }));
  assert.equal(await store.getState().pause('rule-1'), true);
  assert.equal(store.getState().lastControl?.status, 202);
  assert.equal(store.getState().lastControl?.body.inFlightRunId, 'run-1');
});


test('reviewing spent limits keeps lifetime counters and saves disabled before a separate explicit enable', async () => {
  const { wakeInput, onceInput, automationNow }=await import('./fixtures/automation');
  for(const schedule of [false,true]) {
    const input=schedule ? {...onceInput(),trigger:{kind:'interval' as const,anchorAt:automationNow+60000,everyMs:60000}} : wakeInput();
    const {enabled: _enabled,...config}=input;void _enabled;
    const previous={...automationFixture(),...config,limits:{...input.limits,maxDispatches:6},dispatchCount:6,state:'exhausted' as const};
    const saved={...previous,state:'disabled' as const,revision:2,limits:{...previous.limits,maxDispatches:9}};
    const writes:{method:string;body:Record<string,unknown>}[]=[];
    const store=createAutomationStore(schedule ? {worktreeId:'wt-1'} : {sessionId:'session-1'},async(_url,init)=>{
      if(init?.method) {writes.push({method:init.method,body:JSON.parse(String(init.body))});return Response.json({automation:saved,inputOwnership:null,inFlightRunId:null});}
      return Response.json({items:[saved],nextCursor:null});
    });
    assert.equal(await store.getState().save({...input,enabled:true,limits:saved.limits},previous),true);
    assert.equal(writes.length,1);assert.equal(writes[0].method,'PUT');
    const body=writes[0].body.input as Record<string,unknown>;
    assert.equal(body.enabled,false);assert.equal('dispatchCount' in body,false);assert.equal('analysisCount' in body,false);
    assert.equal(store.getState().items[0].dispatchCount,6);assert.equal(store.getState().items[0].state,'disabled');
    assert.equal(await store.getState().enable(saved),true);
    assert.deepEqual(writes[1],{method:'POST',body:{action:'enable',expectedRevision:2}});
  }
});

test('identical in-flight setup checks share one request and preserve the draft', async () => {
  const { autorunPreviewFixture } = await import('./fixtures/autorun-contracts');
  let release!: (response: Response) => void;
  let calls = 0;
  const store = createAutomationStore({ sessionId: 'session-1' }, async () => {
    calls++; return new Promise<Response>(resolve => { release = resolve; });
  });
  store.setState({ drafts: { 'autorun:new:fields': { objective: 'Retained goal' } } });
  const first = store.getState().previewAutorun();
  const second = store.getState().previewAutorun();
  assert.equal(calls, 1);
  release(Response.json(autorunPreviewFixture()));
  assert.ok(await first); assert.ok(await second);
  assert.equal(store.getState().previewLoading, false);
  assert.deepEqual(store.getState().drafts['autorun:new:fields'], { objective: 'Retained goal' });
});

test('a setup check times out truthfully, ignores late success, and recovers only on explicit retry', async context => {
  const { autorunPreviewFixture } = await import('./fixtures/autorun-contracts');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (response: Response) => void;
  let calls = 0;
  let signal: AbortSignal | undefined;
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => {
    calls++; signal = init?.signal ?? undefined;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json(autorunPreviewFixture());
  });
  const first = store.getState().previewAutorun();
  context.mock.timers.tick(120000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(store.getState().previewLoading, false);
  assert.equal(store.getState().previewError, 'PREVIEW_TIMEOUT');
  assert.equal(signal?.aborted, true);
  assert.equal(await first, null);
  assert.equal(calls, 1, 'Timeout must not automatically start another check');
  release(Response.json(autorunPreviewFixture()));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(store.getState().preview, null);
  assert.equal(store.getState().previewError, 'PREVIEW_TIMEOUT');
  assert.ok(await store.getState().previewAutorun());
  assert.equal(calls, 2);
  assert.equal(store.getState().previewError, null);
});

test('only the latest explicitly selected supervisor check can replace preview authority', async () => {
  const { autorunPreviewSchema } = await import('../src/lib/automation/autorun-contracts');
  const { autorunPreviewFixture } = await import('./fixtures/autorun-contracts');
  const first = autorunPreviewSchema.parse(autorunPreviewFixture());
  const selection = { ...first.recommendedSupervisor!, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  const selected = autorunPreviewSchema.parse({ ...first, previewId: 'selected-preview', recommendedSupervisor: selection,
    supervisorCheck: { selection, status: 'available', reason: null }, supervisorOptions: [{ ...first.supervisorOptions[0], selection }] });
  const completions: ((response: Response) => void)[] = [];
  const requests: unknown[] = [];
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return new Promise<Response>(resolve => completions.push(resolve));
  });
  const old = store.getState().previewAutorun({ supervisor: first.recommendedSupervisor! });
  const current = store.getState().previewAutorun({ supervisor: selection });
  assert.equal(await old, null);
  completions[1](Response.json(selected)); await current;
  completions[0](Response.json(first)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests[1], { supervisor: selection, includeSupervisorDiscovery: false });
  assert.equal(store.getState().preview?.previewId, 'selected-preview');
  assert.equal(store.getState().previewLoading, false);
  assert.equal(store.getState().previewError, null);
});
