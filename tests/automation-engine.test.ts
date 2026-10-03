import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input } from './automation-fixture';
import { AutomationEngine } from '../src/lib/automation/engine';

test('duplicate ticks deliver one immutable run; pause after paste permits only its finishing Enter', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    const created = await f.service.create('owner', 'key', input());
    const bytes: string[] = [];
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const id = engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => { bytes.push(engine.loadRun(runId).prompt); });
      await f.service.pause('owner', created.automation.id);
      assert.throws(() => engine.withWriteFence(permit, 'begin', () => bytes.push('duplicate')));
      engine.withWriteFence(permit, 'complete', () => bytes.push('Enter'));
      return { kind: 'delivered', sessionId: id, terminalId: 'terminal', at: 60_000 };
    };
    await engine.tick(); f.setNow(60_000);
    await Promise.all([engine.tick(), engine.tick()]); await engine.tick();
    assert.deepEqual(bytes, ['continue fixture', 'Enter']);
    const history = f.service.history('owner', created.automation.id, {}).items;
    assert.equal(history.length, 1); assert.equal(history[0].state, 'delivered');
    assert.equal(f.service.detail('owner', created.automation.id).automation.dispatchCount, 1);
  } finally { f.close(); }
});

test('crash after a possible write stays unknown on recovery and requires acknowledgement without retry', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    const created = await f.service.create('owner', 'key', input());
    let writes = 0;
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => { writes++; throw new Error('lost receipt'); });
      throw new Error('unreachable');
    };
    await engine.tick(); f.setNow(60_000); await engine.tick();
    const run = f.service.history('owner', created.automation.id, {}).items[0];
    assert.equal(run.state, 'unknown');
    let reconciles = 0;
    f.runtime.reconcileRun = async ({ runId }) => { assert.equal(runId, run.id); reconciles++; return { kind: 'unknown', reason: 'unconfirmed', inputOwnership: f.runtime.ownership('owner', 's') }; };
    const restarted = new AutomationEngine(f.service, 'new-instance');
    f.setNow(90_000); await restarted.tick(); await restarted.tick();
    assert.equal(reconciles, 1); assert.equal(writes, 1);
    const resolved = await f.service.resolve('owner', created.automation.id, run.id);
    assert.equal(resolved.run.state, 'unknown');
    assert.equal(resolved.automation.state, 'disabled');
    assert.equal(resolved.automation.dispatchCount, 1);
    assert.equal((await f.service.resolve('owner', created.automation.id, run.id)).run.state, 'unknown');
    assert.equal(writes, 1);
  } finally { f.close(); }
});

test('an armed completed turn fires once across same-process sleep and only a fresh lead turn creates the next wake', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    await engine.tick();
    const wake = { ...input(), target: { kind: 'wake-session' as const, sessionId: 's' }, trigger: { kind: 'turn-complete' as const, delayMs: 30_000 } };
    const created = await f.service.create('owner', 'wake', wake);
    await f.runtime.arm({userId:'owner',sessionId:'s',automationId:created.automation.id,selection:created.automation.savedSelection},(e,o)=>{
      engine.recordInputOwnership('owner',o); if(e.kind==='completed') engine.recordBoundary({userId:'owner',boundary:e.boundary});
    });
    let sends = 0;
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision, expectedBoundary }) => {
      assert.equal(expectedBoundary?.source, 'confirmed-lead-turn');
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => { sends++; });
      engine.withWriteFence(permit, 'complete', () => {});
      return { kind: 'delivered', sessionId: 's', terminalId: 't', at: 40_000 };
    };
    f.setNow(40_000); await engine.tick(); await engine.tick();
    assert.equal(sends, 1);
    const boundary = { id: 'new', serverInstanceId: 'server', terminalId: 't', generation: 1, sessionId: 's', userId: 'owner', turnSequence: 2, inputRevision: 1, completedAt: 40_000, source: 'confirmed-lead-turn' as const };
    engine.recordBoundary({ userId: 'owner', boundary }); engine.recordBoundary({ userId: 'owner', boundary });
    assert.equal(f.service.history('owner', created.automation.id, {}).items.length, 2);
    f.setNow(75_000); await engine.tick(); assert.equal(sends, 2);
  } finally { f.close(); }
});

test('creation overlap is held until an authoritative settled turn with clear children; foreign and stale observations cannot release it', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    const first = await f.service.create('owner', 'first', input());
    const second = await f.service.create('owner', 'second', input());
    const launched: string[] = [];
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const id = engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => { launched.push(id); });
      return { kind: 'delivered', sessionId: id, terminalId: 'terminal', at: 60_000 };
    };
    await engine.tick(); f.setNow(60_000); await engine.tick();
    assert.equal(launched.length, 1);
    const blocked = [first, second].find(v => f.service.history('owner', v.automation.id, {}).items[0].state === 'deferred')!;
    assert.equal(f.service.detail('owner', blocked.automation.id).automation.dispatchCount, 0);
    const event = { userId: 'owner', sessionId: launched[0], terminalId: 'terminal', serverInstanceId: 'server', generation: 1, sequence: 1, observedAt: 60_000, state: 'turn-complete' as const, backgroundWork: 'unknown' as const, exitKind: null };
    engine.recordRuntimeObservation({ ...event, userId: 'other', backgroundWork: 'clear' });
    engine.recordRuntimeObservation(event);
    engine.recordRuntimeObservation({ ...event, backgroundWork: 'clear' });
    f.setNow(90_000); await engine.tick(); assert.equal(launched.length, 1);
    engine.recordRuntimeObservation({ ...event, sequence: 2, backgroundWork: 'clear' });
    f.setNow(120_000); await engine.tick(); assert.equal(launched.length, 2);
  } finally { f.close(); }
});

test('the recovery fence refuses a reserved Session deleted during preparation and never repeats ambiguous resume', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    const created = await f.service.create('owner', 'key', input());
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const id = engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => {});
      return { kind: 'unknown', reason: 'missing-receipt', sessionId: id };
    };
    await engine.tick(); f.setNow(60_000); await engine.tick();
    const run = f.service.history('owner', created.automation.id, {}).items[0];
    let resumeWrites = 0;
    const restarted = new AutomationEngine(f.service, 'replacement');
    f.runtime.reconcileRun = async ({ runId, leaseEpoch }) => {
      f.db.prepare('UPDATE sessions SET deleted=1 WHERE id=?').run(run.sessionId);
      assert.throws(() => restarted.withRecoveryFence({ runId, leaseEpoch, sessionId: run.sessionId! }, () => true, () => { resumeWrites++; }), { code: 'NOT_FOUND' });
      return { kind: 'unknown', reason: 'deleted', inputOwnership: f.runtime.ownership('owner', run.sessionId!) };
    };
    f.setNow(90_000); await restarted.tick();
    assert.equal(resumeWrites, 0);
  } finally { f.close(); }
});

test('lease takeover fences a delayed Enter from the stale backend', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'old');
  try {
    const created = await f.service.create('owner', 'lease', input());
    let pasted!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { pasted = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const writes: string[] = [];
    f.runtime.dispatch = async ({ runId, leaseEpoch, expectedRevision }) => {
      const sessionId = engine.reserveSession(runId, f.createSession);
      const permit = engine.beginAttempt(runId, leaseEpoch, expectedRevision);
      engine.withWriteFence(permit, 'begin', () => writes.push('paste')); pasted();
      await gate;
      engine.withWriteFence(permit, 'complete', () => writes.push('Enter'));
      return { kind: 'delivered', sessionId, terminalId: 'terminal', at: 90_000 };
    };
    await engine.tick(); f.setNow(60_000); const sending = engine.tick(); await ready;
    const replacement = new AutomationEngine(f.service, 'new');
    f.setNow(90_000); await replacement.tick(); finish(); await sending;
    assert.deepEqual(writes, ['paste']);
    assert.equal(f.service.history('owner', created.automation.id, {}).items[0].state, 'unknown');
  } finally { f.close(); }
});

test('wake dispatch refuses drift from the exact saved nullable launch choices', async () => {
  const f = fixture(); const engine = new AutomationEngine(f.service, 'instance');
  try {
    await engine.tick();
    const inherited = { ...input(), target: { kind: 'wake-session' as const, sessionId: 's' }, trigger: { kind: 'turn-complete' as const, delayMs: 30_000 } };
    const saved = { ...((await f.service.deps.inspect('owner', inherited.target, 'wsl')).selection), model: null, reasoningEffort: null, serviceTier: null };
    f.service.deps.inspect = async () => ({ selection: saved, canonicalWorktreeId: null, assertCurrent() {} });
    const created = await f.service.create('owner', 'inherited', inherited);
    await f.runtime.arm({userId:'owner',sessionId:'s',automationId:created.automation.id,selection:saved},(e,o)=>{
      engine.recordInputOwnership('owner',o); if(e.kind==='completed') engine.recordBoundary({userId:'owner',boundary:e.boundary});
    });
    assert.equal(created.automation.savedSelection.model, null);
    let writes = 0;
    f.service.deps.inspect = async () => ({ selection: { ...saved, model: 'changed' }, canonicalWorktreeId: null, assertCurrent() {} });
    f.runtime.dispatch = async () => { writes++; return { kind: 'cancelled', reason: 'test' }; };
    f.setNow(40_000); await engine.tick();
    assert.equal(writes, 0);
    assert.equal(f.service.detail('owner', created.automation.id).automation.state, 'paused');
  } finally { f.close(); }
});
