import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input } from './automation-fixture';
import { AutomationEngine } from '../src/lib/automation/engine';

for (const provenResume of [false, true]) test(`recovery ${provenResume ? 'allows another restart after confirmed runtime ownership' : 'never repeats an ambiguous resume'}`, async () => {
  const f = fixture(); const original = new AutomationEngine(f.service, 'original');
  try {
    const created = await f.service.create('owner', 'recovery', input());
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const sessionId = original.reserveSession(runId, f.createSession);
      const permit = original.beginAttempt(runId, leaseEpoch, expectedRevision);
      original.withWriteFence(permit, 'begin', () => {});
      return { kind: 'delivered', sessionId, terminalId: 'terminal', at: 60_000 };
    };
    await original.tick(); f.setNow(60_000); await original.tick();
    const run = f.service.history('owner', created.automation.id, {}).items[0];
    let current!: AutomationEngine, resumes = 0;
    f.runtime.reconcileRun = async ({ runId, leaseEpoch }) => {
      current.withRecoveryFence({ runId, leaseEpoch, sessionId: run.sessionId! }, () => true, () => { resumes++; if (!provenResume) throw new Error('ambiguous spawn'); });
      return { kind: 'resumed', observation: { userId: 'owner', sessionId: run.sessionId!, terminalId: 'terminal', serverInstanceId: `server-${resumes}`, generation: resumes, sequence: 1, observedAt: 90_000, state: 'running', backgroundWork: 'unknown', exitKind: null }, inputOwnership: f.runtime.ownership('owner', run.sessionId!) };
    };
    current = new AutomationEngine(f.service, 'restart-one'); f.setNow(90_000); await current.tick();
    current = new AutomationEngine(f.service, 'restart-two'); f.setNow(120_000); await current.tick();
    assert.equal(resumes, provenResume ? 2 : 1);
    const final = f.service.history('owner', created.automation.id, {}).items.find(r => r.id === run.id)!;
    assert.equal(final.state, 'delivered');
    assert.equal(f.service.detail('owner', created.automation.id).automation.dispatchCount, 1);
  } finally { f.close(); }
});
