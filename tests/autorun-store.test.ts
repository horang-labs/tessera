import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationStore } from '../src/stores/automation-store';
import { autorunPreviewFixture, autorunInput, boundary, contextSnapshot } from './fixtures/autorun-contracts';

test('a slow preview cannot replace newer readiness, and consumed idle stays unavailable to start', async () => {
  let release!: (r: Response) => void;
  let calls = 0;
  const store = createAutomationStore({ sessionId: 'session-1' }, async () => ++calls === 1
    ? new Promise<Response>(r => { release = r; })
    : Response.json({ ...autorunPreviewFixture(), readiness: { kind: 'idle', reason: 'consumed-boundary' } }));
  const old = store.getState().previewAutorun();
  await store.getState().previewAutorun();
  release(Response.json(autorunPreviewFixture()));
  await old;
  assert.equal(store.getState().preview?.readiness.kind, 'idle');
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
