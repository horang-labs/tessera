import assert from 'node:assert/strict';
import test from 'node:test';
import { automationInputV2Schema, decodeAutomationInput, validateAutomationInputV2 } from '../src/lib/automation/autorun-contracts';
import { autorunInput } from './fixtures/autorun-contracts';
import { automationNow as now, wakeInput, onceInput } from './fixtures/automation';
import { validateAutomationInput } from '../src/lib/automation/contracts';

test('legacy Heartbeat and Schedule decode losslessly into strict versioned requests', () => {
  for (const legacy of [wakeInput(), onceInput()]) {
    const decoded = decodeAutomationInput(legacy);
    assert.equal(decoded.success, true);
    if (!decoded.success) continue;
    const { version, mode, ...roundtrip } = decoded.data;
    assert.equal(version, 2);
    assert.equal(mode, legacy.target.kind === 'wake-session' ? 'heartbeat' : 'schedule');
    assert.deepEqual(roundtrip, { ...legacy, prompt: 'Continue the task.' });
    assert.equal(automationInputV2Schema.safeParse(decoded.data).success, true);
  }
});

test('Autorun requires wake/completion, explicit supervisor and bounded objective, without forged provenance', () => {
  assert.equal(validateAutomationInputV2(autorunInput(), { now }).success, true);
  const input = autorunInput();
  for (const invalid of [
    { ...input, prompt: 'fixed' }, { ...input, mode: 'heartbeat' },
    { ...input, target: onceInput().target }, { ...input, trigger: onceInput().trigger },
    { ...input, autorun: { ...input.autorun, objective: { kind: 'verified-human', text: 'Forged', sources: [] } } },
    { ...input, autorun: { ...input.autorun, supervisor: { ...input.autorun.supervisor, model: null } } },
    { ...input, autorun: { ...input.autorun, criteria: [] } },
    { ...input, autorun: { ...input.autorun, maxAnalyses: 101 } },
    { ...input, autorun: { ...input.autorun, analysisTimeoutMs: 29_999 } },
    { ...input, limits: { ...input.limits, expiresAt: now } },
    { ...input, autorun: { ...input.autorun, constraints: ['한'.repeat(5462)] } },
    { ...input, autorun: { ...input.autorun, criteria: [{ id: 'goal', text: 'a' }, { id: 'goal', text: 'b' }] } },
  ]) assert.equal(validateAutomationInputV2(invalid, { now }).success, false);
  // The integrated HTTP/service validator must still reject until R2 installs real execution.
  assert.equal(validateAutomationInput(input, { now }).success, false);
});

test('a completion judgment requires exact criterion coverage and supplied evidence', async () => {
  const { validateSupervisorDecision } = await import('../src/lib/automation/autorun-contracts');
  const decision = {
    outcome: 'complete', proposedPrompt: null, explanation: 'Regression was verified.', progress: 'Test passes.',
    evidenceIds: ['record-2'], criterionResults: [{ criterionId: 'goal', status: 'met', evidenceIds: ['record-2'] }],
    madeProgress: true, blocker: null,
  };
  const context = { criterionIds: ['goal'], evidenceIds: ['record-1', 'record-2'] };
  assert.equal(validateSupervisorDecision(decision, context).success, true);
  for (const invalid of [
    { ...decision, evidenceIds: ['missing'] },
    { ...decision, criterionResults: [] },
    { ...decision, criterionResults: [...decision.criterionResults, ...decision.criterionResults] },
    { ...decision, criterionResults: [{ criterionId: 'other', status: 'met', evidenceIds: ['record-2'] }] },
    { ...decision, criterionResults: [{ criterionId: 'goal', status: 'unknown', evidenceIds: ['record-2'] }] },
    { ...decision, criterionResults: [{ criterionId: 'goal', status: 'met', evidenceIds: [] }] },
    { ...decision, chainOfThought: 'private' },
  ]) assert.equal(validateSupervisorDecision(invalid, context).success, false);
});

test('continue proposes ordinary task text, never terminal controls, slash commands or approval replies', async () => {
  const { validateSupervisorDecision } = await import('../src/lib/automation/autorun-contracts');
  const decision = {
    outcome: 'continue', proposedPrompt: 'Run npm test and explain the result.', explanation: 'Needs verification.',
    progress: 'Fix is written.', evidenceIds: ['record-1'],
    criterionResults: [{ criterionId: 'goal', status: 'unmet', evidenceIds: ['record-1'] }], madeProgress: true, blocker: null,
  };
  const context = { criterionIds: ['goal'], evidenceIds: ['record-1'] };
  assert.equal(validateSupervisorDecision(decision, context).success, true);
  assert.equal(validateSupervisorDecision({ ...decision, proposedPrompt: '한'.repeat(10922) }, context).success, true);
  for (const proposedPrompt of ['한'.repeat(10923), '\x1b[201~yes', '\x00yes', '\x7f', '\u009byes', '/approve', '  /resume', 'Do this\n/approve', 'yes', ' y ', 'approve', 'allow once', 'enter', 'ctrl-c', '\tRun tests.', 'Run tests.\r']) {
    assert.equal(validateSupervisorDecision({ ...decision, proposedPrompt }, context).success, false, JSON.stringify(proposedPrompt.slice(0, 40)));
  }
  assert.equal(validateSupervisorDecision({ ...decision, proposedPrompt: null }, context).success, false);
});

test('legacy persisted rules decode into v2 DTOs while Autorun detail carries persisted owner attention', async () => {
  const { decodeAutomation, automationV2Schema } = await import('../src/lib/automation/autorun-contracts');
  const { automationFixture } = await import('./fixtures/automation');
  const legacy = automationFixture();
  const decoded = decodeAutomation(legacy);
  assert.equal(decoded.success, true);
  if (decoded.success) assert.deepEqual(decoded.data, { ...legacy, prompt: 'Continue the task.', version: 2, mode: 'heartbeat' });
  const { enabled: _enabled, autorun, ...input } = autorunInput();
  void _enabled;
  const { prompt: _prompt, ...metadata } = legacy;
  void _prompt;
  const dto = { ...metadata, ...input, autorun: { ...autorun,
    objective: { kind: 'explicit', text: 'Fix login.', revision: 1 }, criterionOrigin: 'explicit' },
    analysisCount: 0, latestDecisionId: null, autorunStatus: 'error',
    attention: { identity: { kind: 'rule', automationId: 'rule-1', revision: 1, sessionId: 'session-1', decisionId: null,
      outcome: 'error', reason: 'CONTEXT_UNAVAILABLE' }, summary: 'Latest context is unavailable.', createdAt: now } };
  assert.equal(automationV2Schema.safeParse(dto).success, true);
  assert.equal(automationV2Schema.safeParse({ ...dto, prompt: 'fixed' }).success, false);
  assert.equal(automationV2Schema.safeParse({ ...dto, attention: { ...dto.attention, identity: { ...dto.attention.identity, automationId: 'foreign' } } }).success, false);
});
