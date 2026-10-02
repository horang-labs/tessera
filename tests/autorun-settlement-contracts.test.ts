import assert from 'node:assert/strict';
import test from 'node:test';
import { supervisorSettlementObservationSchema, type SupervisorSettlementObservation } from '../src/lib/automation/autorun-contracts';
import type { AutorunProviderPort, SupervisorSettlementObservationRequest } from '../src/lib/cli/providers/session-types';

test('recovery result admits only versioned scoped settlement evidence, never decision output', () => {
  const base = { version: 1, userId: 'owner', agentEnvironment: 'wsl', invocationId: 'invocation', observedAt: 1800000000000 };
  const proof = { kind: 'owned-invocation-closed', launchId: 'exclusive-launch', closedAt: 1799999999000, settledAt: 1800000000000 };
  assert.equal(supervisorSettlementObservationSchema.safeParse({ ...base, kind: 'quiescent', code: 'SUPERVISOR_QUIESCENT', proof }).success, true);
  assert.equal(supervisorSettlementObservationSchema.safeParse({ ...base, kind: 'unknown', code: 'SUPERVISOR_PROCESS_UNCERTAIN', reason: 'missing' }).success, true);
  for (const invalid of [{ ...base, kind: 'quiescent', code: 'SUPERVISOR_QUIESCENT' },
    { ...base, kind: 'quiescent', code: 'SUPERVISOR_QUIESCENT', proof, decision: {} },
    { ...base, version: 2, kind: 'quiescent', code: 'SUPERVISOR_QUIESCENT', proof },
    { ...base, userId: '', kind: 'quiescent', code: 'SUPERVISOR_QUIESCENT', proof },
    { ...base, kind: 'quiescent', code: 'SUPERVISOR_QUIESCENT', proof: { ...proof, settledAt: proof.closedAt - 1 } }]) {
    assert.equal(supervisorSettlementObservationSchema.safeParse(invalid).success, false);
  }
});

// The addition is optional: old providers remain assignable; R2 must quarantine on absence.
const consumer = (port: AutorunProviderPort, request: SupervisorSettlementObservationRequest): Promise<SupervisorSettlementObservation> | undefined =>
  port.observeSupervisorSettlement?.(request);
void consumer;
