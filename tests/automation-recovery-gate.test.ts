import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input } from './automation-fixture';
import { AutomationEngine } from '../src/lib/automation/engine';
import { createAutomationRecoveryGate } from '../src/lib/automation/startup';

test('generic recovery launches ordinary Sessions and excludes retained automation Sessions after pause, delete and unknown', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    const created = await f.service.create('owner', 'recover', input());
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const sessionId = engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => {});
      return { kind: 'unknown', reason: 'uncertain', sessionId };
    };
    await engine.tick(); f.setNow(60_000); await engine.tick();
    const run = f.service.history('owner', created.automation.id, {}).items[0];
    const launched: string[] = [];
    const gated = createAutomationRecoveryGate(async request => { launched.push(request.sessionId); }, f.repo);
    await gated({ sessionId: 'ordinary', userId: 'owner', mode: 'detached' });
    await gated({ sessionId: run.sessionId!, userId: 'owner', mode: 'detached' });
    await f.service.pause('owner', created.automation.id, true);
    await gated({ sessionId: run.sessionId!, userId: 'owner', mode: 'detached' });
    assert.deepEqual(launched, ['ordinary']);
    assert.equal(f.service.history('owner', created.automation.id, {}).items[0].state, 'unknown');
    assert.equal(f.service.detail('owner', created.automation.id).automation.state, 'deleted');
  } finally { f.close(); }
});
