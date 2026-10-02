import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input } from './automation-fixture';
import { AutomationEngine } from '../src/lib/automation/engine';

test('an overdue once occurrence is retained as missed without consuming a dispatch', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'one');
  try {
    const rule = await f.service.create('owner', 'once', { ...input(), trigger: { kind: 'once', at: 60_000 }, limits: { maxDispatches: 1, expiresAt: 259_200_000 } });
    let called = false;
    f.runtime.dispatch = async () => { called = true; return { kind: 'failed', reason: 'unexpected' }; };
    await engine.tick(); f.setNow(90_060_000); await engine.tick();
    assert.equal(called, false);
    const runs = f.service.history('owner', rule.automation.id, {}).items;
    assert.equal(runs.length, 1); assert.equal(runs[0].state, 'skipped');
    assert.equal(runs[0].reason, 'missed-deadline');
    assert.equal(f.service.detail('owner', rule.automation.id).automation.state, 'disabled');
    assert.equal(f.service.detail('owner', rule.automation.id).automation.dispatchCount, 0);
  } finally { f.close(); }
});

test('a failed attempt with proven no action consumes its limit and releases Worktree overlap', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'one');
  try {
    const first = await f.service.create('owner', 'first', { ...input(), limits: { ...input().limits, maxDispatches: 1 } });
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      engine.reserveSession(runId, f.createSession);
      engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      return { kind: 'failed', reason: 'preparation-rejected' };
    };
    await engine.tick(); f.setNow(60_000); await engine.tick();
    const detail = f.service.detail('owner', first.automation.id);
    assert.equal(detail.automation.dispatchCount, 1);
    assert.equal(detail.automation.state, 'paused');
    await assert.rejects(f.service.enable('owner', first.automation.id, detail.automation.revision), { code: 'INVALID_AUTOMATION' });
    f.setNow(60_001);
    const second = await f.service.create('owner', 'second', { ...input(), trigger: { kind: 'once', at: 120_000 }, limits: { ...input().limits, maxDispatches: 1 } });
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const sessionId = engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => {});
      return { kind: 'delivered', sessionId, terminalId: 'terminal', at: 120_000 };
    };
    f.setNow(120_000); await engine.tick();
    assert.equal(f.service.history('owner', second.automation.id, {}).items[0].state, 'delivered');
    assert.equal(f.service.detail('owner', second.automation.id).automation.state, 'exhausted');
    f.setNow(180_000); await engine.tick();
    assert.equal(f.service.history('owner', second.automation.id, {}).items.length, 1);
  } finally { f.close(); }
});
