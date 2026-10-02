import assert from 'node:assert/strict';
import test from 'node:test';
import { autorunPreviewSchema, automationAttentionSchema, automationAttentionEventSchema } from '../src/lib/automation/autorun-contracts';
import { getAutorunAttentionKey } from '../src/lib/automation/client-state';
import { getAutorunRuntimePort, type AutorunRuntimePort, type AnalysisDecisionCommit } from '../src/lib/automation/runtime-port';
import { boundary, autorunInput, contextSnapshot, autorunPreviewFixture } from './fixtures/autorun-contracts';

test('preview distinguishes first running turn, fresh completion, consumed idle and unavailable completed context', () => {
  const base = autorunPreviewFixture();
  assert.equal(autorunPreviewSchema.safeParse(base).success, true);
  const { completionHookId: _hook, ...submission } = contextSnapshot().correlation;
  void _hook;
  const running = { kind: 'running', acceptedTurn: { serverInstanceId: boundary.serverInstanceId,
    terminalId: boundary.terminalId, generation: boundary.generation, sessionId: boundary.sessionId,
    userId: boundary.userId, turnSequence: boundary.turnSequence, inputRevision: boundary.inputRevision }, submission };
  for (const readiness of [running, { kind: 'idle', reason: 'consumed-boundary' },
    { kind: 'unavailable', code: 'CONTEXT_UNAVAILABLE', reason: 'malformed' }]) {
    assert.equal(autorunPreviewSchema.safeParse({ ...base, readiness }).success, true);
  }
  for (const invalid of [
    { ...base, readiness: { kind: 'completed', boundary, fresh: false, context: base.readiness.context } },
    { ...base, readiness: { ...running, context: base.readiness.context } },
    { ...base, readiness: { kind: 'idle', reason: 'consumed-boundary', canArm: true } },
    { ...base, recommendedSupervisor: { ...base.recommendedSupervisor, model: 'unproven' } },
    { ...base, readiness: { ...base.readiness, boundary: { ...boundary, sessionId: 'foreign' } } },
  ]) assert.equal(autorunPreviewSchema.safeParse(invalid).success, false);
});

test('owner attention before a decision exists has durable rule identity and text-free invalidation', () => {
  const attention = { kind: 'rule', automationId: 'rule-1', revision: 2, sessionId: 'session-1',
    decisionId: null, outcome: 'error', reason: 'CONTEXT_UNAVAILABLE' };
  const parsed = automationAttentionSchema.parse(attention);
  assert.equal(getAutorunAttentionKey(parsed), 'autorun:rule-1:2:CONTEXT_UNAVAILABLE');
  const decision = automationAttentionSchema.parse({ ...attention, kind: 'decision', decisionId: 'decision-1', outcome: 'complete', reason: null });
  assert.equal(getAutorunAttentionKey(decision), 'autorun:decision-1:complete');
  assert.equal(automationAttentionEventSchema.safeParse({ ...attention, type: 'automation_attention' }).success, true);
  for (const invalid of [{ ...attention, decisionId: 'fake' }, { ...attention, outcome: 'complete' }]) {
    assert.equal(automationAttentionSchema.safeParse(invalid).success, false);
  }
  for (const field of ['text', 'summary', 'prompt', 'objective', 'packet']) {
    assert.equal(automationAttentionEventSchema.safeParse({ ...attention, type: 'automation_attention', [field]: 'private' }).success, false);
  }
});

test('an absent runtime capability is explicit and decision commit disallows asynchronous DB callbacks', () => {
  assert.deepEqual(getAutorunRuntimePort({}), { kind: 'unavailable', code: 'RUNTIME_ADAPTER_UNAVAILABLE' });
  // Compile-time assertions exercise the published port, without pretending to implement a runtime gate.
  type Commit = Parameters<AutorunRuntimePort['commitAnalysisDecision']>[1];
  const synchronous: Commit = () => ({ decisionId: 'decision-1', automationRevision: 1 });
  assert.deepEqual(synchronous(), { decisionId: 'decision-1', automationRevision: 1 });
  // @ts-expect-error An async transaction cannot hold the runtime gate across awaits.
  const asynchronous: Commit = async (): Promise<AnalysisDecisionCommit> => ({ decisionId: 'decision-1', automationRevision: 1 });
  void asynchronous;
});

test('decision pages omit private text and owner detail rejects foreign packet/outcome linkage', async () => {
  const { autorunDecisionPageSchema, autorunDecisionDetailSchema, autorunDecisionQuerySchema } = await import('../src/lib/automation/autorun-contracts');
  const summary = { id: 'decision-1', automationId: 'rule-1', automationRevision: 1, goalRevision: 1, boundaryId: boundary.id,
    phase: 'decided', outcome: 'complete', reason: null, coverage: contextSnapshot().coverage,
    supervisorSelection: autorunInput().autorun.supervisor, cliVersion: '0.159.2', runId: null,
    delivery: 'not-requested', createdAt: boundary.completedAt, finishedAt: boundary.completedAt, retryAt: null, analysisAttempts: 1 };
  assert.equal(autorunDecisionPageSchema.safeParse({ items: [summary], nextCursor: null }).success, true);
  assert.deepEqual(autorunDecisionQuerySchema.parse({}), { limit: 50 });
  assert.equal(autorunDecisionQuerySchema.safeParse({ limit: 101 }).success, false);
  for (const field of ['packet', 'proposedPrompt', 'explanation', 'progress']) {
    assert.equal(autorunDecisionPageSchema.safeParse({ items: [{ ...summary, [field]: 'private' }], nextCursor: null }).success, false);
  }
  const detail = { ...summary, packet: { version: 1, objective: { kind: 'explicit', text: 'Fix login.', revision: 1 },
    constraints: [], criteria: [{ id: 'goal', text: 'Test passes.' }], criterionOrigin: 'explicit', context: contextSnapshot(), priorDecisions: [] },
    packetHash: 'c'.repeat(64), decision: { outcome: 'complete', proposedPrompt: null, explanation: 'Test passes.', progress: 'Fixed.',
      evidenceIds: ['record-2'], criterionResults: [{ criterionId: 'goal', status: 'met', evidenceIds: ['record-2'] }], madeProgress: true, blocker: null },
    effectiveSelection: { kind: 'requested-only' }, attempts: [], attention: null };
  assert.equal(autorunDecisionDetailSchema.safeParse(detail).success, true);
  for (const invalid of [
    { ...detail, boundaryId: 'previous' }, { ...detail, goalRevision: 2 },
    { ...detail, outcome: 'continue' }, { ...detail, runId: 'fake-delivery', delivery: 'delivered' },
    { ...detail, effectiveSelection: { kind: 'verified', selection: { ...detail.supervisorSelection, model: 'fallback' } } },
  ]) assert.equal(autorunDecisionDetailSchema.safeParse(invalid).success, false);
});
