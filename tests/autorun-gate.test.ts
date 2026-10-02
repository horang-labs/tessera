import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomationInputGate } from '../src/lib/automation/input-gate';
import { hookSubmissionFixture } from './fixtures/autorun-contracts';

test('native hook association needs exact owner, environment, binding and current accepted turn', () => {
  const gate = new AutomationInputGate();
  gate.started('owner-1', 'session-1', 'terminal-1', 1, 'codex', 'wsl');
  gate.bindConversation('owner-1', 'session-1', 'conversation-1');
  gate.hook('owner-1', 'session-1', 'UserPromptSubmit', 'running', 1000, false);
  const event = hookSubmissionFixture();
  event.evidence.serverInstanceId = gate.serverInstanceId;
  assert.equal(gate.recordHookEvidence({ ...event, userId: 'foreign' }).kind, 'rejected');
  assert.equal(gate.recordHookEvidence({ ...event, agentEnvironment: 'native' }).kind, 'rejected');
  assert.equal(gate.recordHookEvidence({ ...event, evidence: { ...event.evidence, terminalGeneration: 2 } }).kind, 'rejected');
  assert.equal(gate.recordHookEvidence(event).kind, 'accepted');
  assert.equal(gate.readTurnEvidence({ userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl' }).kind, 'running');
  gate.dirty('owner-1', 'session-1');
  assert.notEqual(gate.readTurnEvidence({ userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl' }).kind, 'running');
  assert.equal(gate.recordHookEvidence(event).kind, 'rejected');
});

test('a real gate rejects a current-looking completion after native approval or a binding change', () => {
  const gate = new AutomationInputGate();
  gate.started('owner-1', 'session-1', 'terminal-1', 1, 'codex', 'wsl');
  gate.bindConversation('owner-1', 'session-1', 'conversation-1');
  gate.hook('owner-1', 'session-1', 'UserPromptSubmit', 'running', 1000, false);
  const event = hookSubmissionFixture();
  event.evidence.serverInstanceId = gate.serverInstanceId;
  gate.recordHookEvidence(event);
  gate.recordHookEvidence({ ...event, kind: 'completion', evidence: { ...event.evidence, completionHookId: 'stop' } });
  gate.hook('owner-1', 'session-1', 'Stop', 'completed', 2000, false, 'successful-lead-stop');
  const turn = gate.readTurnEvidence({ userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl' });
  assert.equal(turn.kind, 'completed');
  if (turn.kind !== 'completed') throw new Error('completion required');
  const own = gate.arm('owner-1', 'session-1', 'rule', 'codex', () => {});
  const expected = { userId: 'owner-1', sessionId: 'session-1', agentEnvironment: 'wsl' as const,
    expectedBoundary: turn.boundary, inputEpoch: own.epoch, automationId: 'rule', providerConversationId: 'conversation-1' };
  gate.commitAnalysis(expected, () => ({ decisionId: 'decision', automationRevision: 1 }));
  gate.hook('owner-1', 'session-1', 'PermissionRequest', 'input_required', 3000, false);
  let committed = false;
  assert.equal(gate.commitAnalysis(expected, () => { committed = true; return { decisionId: 'decision', automationRevision: 1 }; }).kind, 'rejected');
  assert.equal(committed, false);
});
