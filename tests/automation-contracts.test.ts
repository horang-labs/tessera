import assert from 'node:assert/strict';
import test from 'node:test';
import { getAutomationDefaults, validateAutomationInput } from '../src/lib/automation/contracts';

import { automationNow as now, wakeInput as wake, onceInput as once, explicitSelection as selection, inheritedSelection } from './fixtures/automation';
import type { AutomationInput } from '../src/lib/automation/contracts';

test('wake defaults are finite and validation preserves opt-in while normalizing prompt', () => {
  assert.deepEqual(getAutomationDefaults('turn-complete', now), {
    delayMs: 120_000, limits: { maxDispatches: 10, expiresAt: 1_800_028_800_000 },
  });
  const result = validateAutomationInput(wake(), { now });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.prompt, 'Continue the task.');
    assert.equal(result.data.enabled, false);
  }
});

test('invalid trigger/target combinations and unbounded schedules cannot be saved', () => {
  const invalid = [
    { ...wake(), trigger: { kind: 'once', at: now + 60_000 } },
    { ...wake(), limits: { maxDispatches: 10, expiresAt: now } },
    { ...wake(), limits: { maxDispatches: 10, expiresAt: now + 7_776_000_001 } },
  ];
  for (const input of invalid) assert.equal(validateAutomationInput(input, { now }).success, false);
});

const supported = { now, isSelectionSupported: () => true };

test('new launches require explicit supported selection and a single future occurrence', () => {
  assert.equal(validateAutomationInput(once(), supported).success, true);
  for (const input of [
    { ...once(), limits: { ...once().limits, maxDispatches: 2 } },
    { ...once(), trigger: { kind: 'once', at: now } },
    { ...once(), trigger: { kind: 'once', at: once().limits.expiresAt } },
    { ...once(), target: { ...once().target, selection: { ...selection, model: null } } },
    { ...once(), target: { ...once().target, selection: { ...selection, reasoningEffort: null } } },
    { ...once(), target: { ...once().target, selection: { ...selection, serviceTier: null } } },
  ]) assert.equal(validateAutomationInput(input, supported).success, false);
  const unsupported = validateAutomationInput(once(), { now, isSelectionSupported: () => false });
  assert.equal(unsupported.success, false);
  if (!unsupported.success) assert.equal(unsupported.error.code, 'UNSUPPORTED_SELECTION');
  assert.equal(validateAutomationInput(once(), { now }).success, false);
});

test('interval edits retain only an unchanged persisted anchor', () => {
  const input: AutomationInput = { ...once(), trigger: { kind: 'interval', anchorAt: now - 60_000, everyMs: 60_000 } };
  assert.equal(validateAutomationInput(input, supported).success, false);
  assert.equal(validateAutomationInput(input, { ...supported, previousInput: input }).success, true);
  assert.equal(validateAutomationInput({ ...input, trigger: { ...input.trigger, anchorAt: now - 1 } }, { ...supported, previousInput: input }).success, false);
  assert.equal(validateAutomationInput({ ...input, trigger: { ...input.trigger, anchorAt: input.limits.expiresAt } }, supported).success, false);
});

test('an existing inherited Session snapshot stays nullable and exact', async () => {
  const { sessionSelectionSnapshotSchema, sameSessionSelection } = await import('../src/lib/automation/contracts');
  const inherited = inheritedSelection;
  assert.deepEqual(sessionSelectionSnapshotSchema.parse(inherited), inherited);
  assert.equal(sameSessionSelection(inherited, { ...inherited }), true);
  assert.equal(sameSessionSelection(inherited, { ...inherited, model: 'test-model' }), false);
  assert.equal(sameSessionSelection(inherited, { ...inherited, reasoningEffort: 'high' }), false);
  assert.equal(sameSessionSelection(inherited, { ...inherited, serviceTier: 'default' }), false);
  assert.equal(sameSessionSelection(inherited, { ...inherited, provider: 'claude-code' }), false);
});

test('strict validation rejects unknown fields at every level and enforces UTF-8 and finite bounds', () => {
  for (const input of [
    { ...wake(), ownerUserId: 'foreign' },
    { ...wake(), agentEnvironment: 'native' },
    { ...wake(), target: { ...wake().target, extra: true } },
    { ...wake(), trigger: { ...wake().trigger, cron: '* * * * *' } },
    { ...wake(), limits: { ...wake().limits, extra: true } },
    { ...once(), target: { ...once().target, selection: { ...selection, extra: true } } },
    { ...once(), target: { ...once().target, selection: { ...selection, settings: { ...selection.settings, argv: '--unsafe' } } } },
    { ...wake(), prompt: '한'.repeat(10_923) },
    { ...wake(), prompt: '\r\n  ' },
    { ...wake(), name: 'x'.repeat(121) },
    { ...wake(), trigger: { kind: 'turn-complete', delayMs: 29_999 } },
    { ...wake(), trigger: { kind: 'turn-complete', delayMs: 86_400_001 } },
    { ...wake(), limits: { ...wake().limits, maxDispatches: 101 } },
    { ...wake(), limits: { ...wake().limits, maxDispatches: 0 } },
    { ...wake(), limits: { ...wake().limits, maxDispatches: 1.5 } },
    { ...wake(), limits: { ...wake().limits, expiresAt: Infinity } },
    { ...once(), trigger: { kind: 'interval', anchorAt: now + 1, everyMs: 59_999 } },
    { ...once(), trigger: { kind: 'interval', anchorAt: now + 1, everyMs: 2_592_000_001 } },
  ]) {
    const result = validateAutomationInput(input, supported);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(JSON.stringify(result).includes('--unsafe'), false);
  }
  assert.equal(validateAutomationInput({ ...wake(), prompt: 'a'.repeat(32_768) }, supported).success, true);
  assert.equal(validateAutomationInput({ ...wake(), prompt: '한'.repeat(10_922) }, supported).success, true);
  assert.deepEqual(getAutomationDefaults('once', now), { limits: { maxDispatches: 1, expiresAt: 1_802_592_000_000 } });
  assert.deepEqual(getAutomationDefaults('interval', now), { limits: { maxDispatches: 100, expiresAt: 1_802_592_000_000 } });
});
