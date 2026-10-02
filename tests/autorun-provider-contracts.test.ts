import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSupervisorFinalResult, supervisorCapabilitySchema } from '../src/lib/automation/autorun-contracts';
import { getAutorunProviderPort } from '../src/lib/cli/providers/provider-contract';
import { autorunInput, supervisorFinalFixture } from './fixtures/autorun-contracts';

test('partial, unsuccessful or uncertain supervisor settlements never authorize a decision', () => {
  const final = supervisorFinalFixture();
  const context = { selection: autorunInput().autorun.supervisor, criterionIds: ['goal'], evidenceIds: ['record-2'] };
  assert.equal(validateSupervisorFinalResult(final, context).success, true);
  for (const invalid of [
    { ...final, settlement: { exitCode: 1, quiescent: true } },
    { ...final, settlement: { exitCode: 0, quiescent: false } },
    { ...final, kind: 'timeout' },
    { ...final, finality: { ...final.finality, event: 'agent-message' } },
    { ...final, finality: { ...final.finality, structuredDecisionCount: 2 } },
    { ...final, finality: { ...final.finality, executableReceipts: 1 } },
    { ...final, selection: { ...final.selection, serviceTier: 'fast' } },
    { ...final, effectiveSelection: { kind: 'verified', selection: { ...final.selection, model: 'other' } } },
    { ...final, cliVersion: '0.160.0' },
  ]) assert.equal(validateSupervisorFinalResult(invalid, context).success, false);
});

test('only exact proven selection/version/isolation combinations can advertise supervisor capability', () => {
  const proof = { version: 1, selection: autorunInput().autorun.supervisor, cliVersion: '0.159.2',
    proofId: 'codex-0.159.2-packet-catalog-v1', isolationPolicyVersion: 'autorun-530-v1',
    available: true, checkedAt: 1800000000000 };
  assert.equal(supervisorCapabilitySchema.safeParse(proof).success, true);
  for (const invalid of [
    { ...proof, cliVersion: '0.160.0' }, { ...proof, proofId: 'read-only-sandbox' },
    { ...proof, selection: { ...proof.selection, model: 'other' } },
    { ...proof, selection: { ...proof.selection, serviceTier: 'fast' } },
    { ...proof, available: false },
  ]) assert.equal(supervisorCapabilitySchema.safeParse(invalid).success, false);
  assert.deepEqual(getAutorunProviderPort({}), { kind: 'unavailable', code: 'SUPERVISOR_UNSUPPORTED' });
});

test('Claude finality uses native successful result and preserves its explicit tier-null proof', () => {
  const final = supervisorFinalFixture();
  const selection = { provider: 'claude-code' as const, model: 'claude-sonnet-5-5', reasoningEffort: 'high', serviceTier: null };
  const claude = { ...final, selection, cliVersion: '2.1.284',
    finality: { provider: 'claude-code', event: 'result/success', isError: false, terminalReason: 'completed', structuredDecisionCount: 1, executableReceipts: 0 } };
  const context = { selection, criterionIds: ['goal'], evidenceIds: ['record-2'] };
  assert.equal(validateSupervisorFinalResult(claude, context).success, true);
  assert.equal(validateSupervisorFinalResult({ ...claude, finality: { ...claude.finality, isError: true } }, context).success, false);
  assert.equal(validateSupervisorFinalResult({ ...claude, finality: { ...claude.finality, terminalReason: 'timeout' } }, context).success, false);
});

test('failure DTOs carry sanitized codes and never advertise retry while owned termination is uncertain', async () => {
  const { supervisorResultSchema } = await import('../src/lib/automation/autorun-contracts');
  const capacity = { kind: 'capacity', code: 'SUPERVISOR_CAPACITY', invocationId: 'invocation-1',
    settlement: { quiescent: true, exitCode: 1 }, retryAfterMs: 15000 };
  assert.equal(supervisorResultSchema.safeParse(capacity).success, true);
  assert.equal(supervisorResultSchema.safeParse({ ...capacity, settlement: { quiescent: false, exitCode: null } }).success, false);
  assert.equal(supervisorResultSchema.safeParse({ ...capacity, code: 'private stderr text' }).success, false);
  assert.equal(supervisorResultSchema.safeParse({ ...capacity, kind: 'timeout', code: 'SUPERVISOR_TIMEOUT' }).success, false);
  assert.equal(supervisorResultSchema.safeParse({ kind: 'cancelled', code: 'SUPERVISOR_PROCESS_UNCERTAIN', invocationId: 'invocation-1',
    settlement: { quiescent: false, exitCode: null } }).success, true);
});
