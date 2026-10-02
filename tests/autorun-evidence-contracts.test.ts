import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutorunProviderPort, AutorunEvidenceRequest } from '../src/lib/cli/providers/session-types';
import type { AutorunRuntimePort } from '../src/lib/automation/runtime-port';
import { autorunEvidenceResultSchema, autorunHookEvidenceSchema } from '../src/lib/automation/autorun-contracts';
import { firstRunningEvidenceFixture, hookSubmissionFixture } from './fixtures/autorun-contracts';

test('R1 returns verified goal provenance plus first-running submission without a completed snapshot', () => {
  const result = firstRunningEvidenceFixture();
  assert.equal(autorunEvidenceResultSchema.safeParse(result).success, true);
  for (const invalid of [
    { ...result, goal: { kind: 'verified', objective: { ...result.goal.objective, sources: [] } } },
    { ...result, turnEvidence: { ...result.turnEvidence, submission: { ...result.turnEvidence.submission, completionHookId: 'fake' } } },
    { ...result, turnEvidence: { ...result.turnEvidence, acceptedTurn: { ...result.turnEvidence.acceptedTurn, generation: 2 } } },
    { ...result, snapshot: 'imaginary completed context' },
  ]) assert.equal(autorunEvidenceResultSchema.safeParse(invalid).success, false);
  // Consumers compile against the same frozen R1 producer and R2 gate reader/writer contracts.
  type Producer = (request: AutorunEvidenceRequest) => Promise<import('../src/lib/automation/autorun-contracts').AutorunEvidenceResult>;
  const bindProducer = (port: AutorunProviderPort): Producer => port.readAutorunEvidence;
  const bindHooks = (runtime: AutorunRuntimePort) => [runtime.recordHookEvidence, runtime.readTurnEvidence] as const;
  void bindProducer; void bindHooks;
});

test('authenticated submission and completion handoff retain native IDs and generation for the runtime gate', () => {
  const submit = hookSubmissionFixture();
  assert.equal(autorunHookEvidenceSchema.safeParse(submit).success, true);
  assert.equal(autorunHookEvidenceSchema.safeParse({ ...submit, evidence: { ...submit.evidence, nativeTurnId: '' } }).success, false);
  assert.equal(autorunHookEvidenceSchema.safeParse({ ...submit, kind: 'completion' }).success, false);
});
