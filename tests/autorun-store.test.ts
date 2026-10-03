import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationStore } from '../src/stores/automation-store';
import { autorunPreviewFixture, autorunInput, boundary, contextSnapshot } from './fixtures/autorun-contracts';

test('a slow preview cannot replace newer readiness, and consumed idle readiness remains accurately displayed', async () => {
  let release!: (r: Response) => void;
  const initial = autorunPreviewFixture();
  const selected = { ...initial.recommendedSupervisor, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  const requests: unknown[] = [];
  const store = createAutomationStore({ sessionId: 'session-1' }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1 ? new Promise<Response>(r => { release = r; })
      : Response.json({ ...initial, recommendedSupervisor: selected,
        supervisorCheck: { selection: selected, status: 'available', reason: null },
        supervisorOptions: [{ ...initial.supervisorOptions[0], selection: selected }],
        readiness: { kind: 'idle', reason: 'consumed-boundary' } });
  });
  // Distinct selections supersede; identical requests intentionally coalesce.
  const old = store.getState().previewAutorun({ supervisor: initial.recommendedSupervisor });
  await store.getState().previewAutorun({ supervisor: selected });
  release(Response.json(initial));
  await old;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { supervisor: selected, includeSupervisorDiscovery: false });
  assert.equal(store.getState().preview?.readiness.kind, 'idle');
  assert.deepEqual(store.getState().preview?.supervisorCheck.selection, selected);
});

test('decision history retains loaded pages after refresh and only reveals new entries on request', async () => {
  const summary = { id: 'decision-1', automationId: 'rule-1', automationRevision: 1, goalRevision: 1, boundaryId: boundary.id,
    phase: 'decided', outcome: 'complete', reason: null, coverage: contextSnapshot().coverage,
    supervisorSelection: autorunInput().autorun.supervisor, cliVersion: '0.159.2', runId: null, delivery: 'not-requested',
    createdAt: boundary.completedAt, finishedAt: boundary.completedAt, retryAt: null, analysisAttempts: 1 };
  let refreshed = false;
  const store = createAutomationStore({ sessionId: 'session-1' }, async url => String(url).includes('cursor=older')
    ? Response.json({ items: [{ ...summary, id: 'old' }], nextCursor: null })
    : Response.json({ items: refreshed ? [{ ...summary, id: 'new' }, summary] : [summary], nextCursor: 'older' }));
  await store.getState().loadDecisions('rule-1');
  await store.getState().loadDecisions('rule-1', true);
  refreshed = true;
  await store.getState().loadDecisions('rule-1');
  assert.deepEqual(store.getState().decisions['rule-1'].items.map(item => item.id), ['decision-1', 'old']);
  assert.equal(store.getState().newDecisionCount['rule-1'], 1);
  store.getState().showNewDecisions('rule-1');
  assert.deepEqual(store.getState().decisions['rule-1'].items.map(item => item.id), ['new', 'decision-1', 'old']);
});

test('an older detail read cannot replace a newer authoritative revision', async () => {
  const { automationFixture } = await import('./fixtures/automation');
  let release!: (r: Response) => void;
  let calls = 0;
  const body = (revision: number) => ({ automation: { ...automationFixture(), revision }, inputOwnership: null, inFlightRunId: null });
  const store = createAutomationStore({ sessionId: 'session-1' }, async () => ++calls === 1 ? new Promise<Response>(r => { release = r; }) : Response.json(body(3)));
  const old = store.getState().inspect('rule-1');
  await store.getState().inspect('rule-1');
  release(Response.json(body(1))); await old;
  assert.equal(store.getState().details['rule-1'].automation.revision, 3);
});

test('a rejected boundary invalidates ready state and supersedes an in-flight check before recovery', async () => {
  const { automationFixture } = await import('./fixtures/automation');
  let oldReply!: (r: Response) => void;
  let freshReply!: (r: Response) => void;
  let previews = 0;
  const store = createAutomationStore({ sessionId: 'session-1' }, async (url, init) => {
    if (String(url).endsWith('/automation-input')) return Response.json({ ok: true });
    if (String(url).endsWith('autorun-preview')) {
      previews++;
      if (previews === 1) return Response.json(autorunPreviewFixture());
      return new Promise<Response>(resolve => { if (previews === 2) oldReply = resolve; else freshReply = resolve; });
    }
    if (init?.method === 'POST') return Response.json({ error: { code: 'INPUT_BOUNDARY_UNPROVEN' } }, { status: 409 });
    return Response.json({ items: [], nextCursor: null });
  });
  await store.getState().previewAutorun({ supervisor: autorunInput().autorun.supervisor });
  const stale = store.getState().previewAutorun({ supervisor: autorunInput().autorun.supervisor });
  assert.equal(await store.getState().enable({ ...automationFixture(), state: 'paused' }), false);
  assert.equal(store.getState().preview, null, 'Rejected ready projection must disappear immediately');
  assert.equal(store.getState().previewLoading, true, 'One fresh check replaces the failed control');
  assert.equal(store.getState().error, null, 'No old error banner alongside checking');
  oldReply(Response.json(autorunPreviewFixture()));
  await stale;
  assert.equal(store.getState().preview, null, 'Pre-rejection response cannot restore eligibility');
  freshReply(Response.json({ ...autorunPreviewFixture(), readiness: { kind: 'idle', reason: 'consumed-boundary' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previews, 3);
  assert.equal(store.getState().preview?.readiness.kind, 'idle');
  assert.equal(store.getState().previewLoading, false);
});

test('a turn change rechecks the requested tuple rather than retained previous capability', async () => {
  const initial = autorunPreviewFixture();
  const selected = {...initial.recommendedSupervisor,model:'gpt-6-astra',reasoningEffort:'xhigh'};
  const bodies: unknown[]=[];
  const replies: ((response: Response)=>void)[]=[];
  const store=createAutomationStore({sessionId:'session-1'},async (_url,init)=>{
    bodies.push(JSON.parse(String(init?.body)));
    if(bodies.length===1) return Response.json(initial);
    return new Promise<Response>(resolve=>replies.push(resolve));
  });
  await store.getState().previewAutorun({supervisor:initial.recommendedSupervisor});
  const pending=store.getState().previewAutorun({supervisor:selected});
  const fresh=store.getState().recheckAutorunPreview();
  assert.deepEqual(bodies[2],{supervisor:selected,includeSupervisorDiscovery:false});
  assert.equal(await pending,null);
  replies[1](Response.json({...initial,supervisorCheck:{selection:selected,status:'available',reason:null},supervisorOptions:[{...initial.supervisorOptions[0],selection:selected}],recommendedSupervisor:selected}));
  await fresh;
  replies[0](Response.json(initial));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(store.getState().preview?.supervisorCheck.selection,selected);
});
