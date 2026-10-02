import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalManager } from '../src/lib/terminal/terminal-manager';
import { createAutomationRuntime } from '../src/lib/automation/runtime-adapter';
import { authorityFixture, runFixture, explicitSelection } from './fixtures/automation';

test('scheduled creation reserves its identity before fenced ordinary launch and records exact selection', async () => {
  const trace: string[] = [];
  const manager = new TerminalManager(() => {});
  const target = { kind: 'create-session' as const, worktreeId: 'wt', title: 'Scheduled', selection: explicitSelection };
  const authority = authorityFixture({
    loadRun: () => ({ run: { ...runFixture(), sessionId: null, effectiveSelection: explicitSelection }, target, prompt: 'hello', ownerUserId: 'owner' }),
    reserveSession: (_id, create) => { create('reserved'); trace.push('reserved'); return 'reserved'; },
    beginAttempt: (runId, leaseEpoch) => ({ runId, leaseEpoch, token: 'token' }),
    withWriteFence: (_permit, phase, write) => { trace.push(phase); write(); },
    recordOutcome: (_id, result) => trace.push(result.kind),
  });
  const runtime = createAutomationRuntime({ manager, authority: () => authority,
    readSelection: async () => explicitSelection,
    createSession: (id, value) => { assert.equal(id, 'reserved'); assert.deepEqual(value, target); },
    launch: async request => {
      assert.equal(request.sessionId, 'reserved'); assert.equal(request.userId, 'owner');
      assert.equal(request.initialPrompt, 'hello'); assert.equal(request.expectedAgentEnvironment, 'wsl');
      request.spawnFence!(() => { trace.push('spawn'); });
      return { terminalId: 'terminal', attachedToExistingRuntime: false };
    },
  });
  const args = { runId: 'run-1', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: null };
  assert.equal((await runtime.dispatch(args)).kind, 'delivered');
  await runtime.dispatch(args);
  assert.deepEqual(trace, ['reserved', 'begin', 'spawn', 'delivered']);
});

test('recovery resumes only its reserved Session under the recovery fence, with no prompt or new dispatch', async () => {
  const trace: string[] = [];
  const manager = new TerminalManager(() => {}, async () => ({ spawn: () => ({
    write() { throw Error('Recovery must not paste'); }, resize() {}, kill() {}, onData() {}, onExit() {},
  }) }));
  const target = { kind: 'create-session' as const, worktreeId: 'wt', title: 'Reserved', selection: explicitSelection };
  const authority = authorityFixture({
    loadRun: () => ({ run: { ...runFixture(), id: 'recovery', sessionId: 'reserved', state: 'unknown', effectiveSelection: explicitSelection }, target, prompt: 'must not resend', ownerUserId: 'owner' }),
    recordInputOwnership() {}, recordRuntimeObservation() {}, pauseWake() {},
    withRecoveryFence: (args, verify, resume) => { assert.equal(args.sessionId, 'reserved'); assert.equal(verify(), true); trace.push('recovery-fence'); resume(); },
  });
  const runtime = createAutomationRuntime({ manager, authority: () => authority, readSelection: async () => explicitSelection,
    canResume: async id => id === 'reserved',
    launch: async request => {
      assert.equal(request.initialPrompt, undefined); assert.equal(request.sessionId, 'reserved');
      await manager.startDetached({ sessionId: 'reserved', terminalId: 'session-reserved', userId: request.userId, providerId: 'codex', agentEnvironment: request.expectedAgentEnvironment,
        resolvedShell: { command: 'resume-fixture', args: [], cwd: process.cwd() }, spawnFence: request.spawnFence });
      trace.push('resume'); return { terminalId: 'session-reserved', attachedToExistingRuntime: false };
    },
  });
  try {
    const first = await runtime.reconcileRun({ runId: 'recovery', leaseEpoch: 2 });
    assert.equal(first.kind, 'resumed'); assert.equal(first.inputOwnership.mode, 'recovery-required');
    assert.equal((await runtime.reconcileRun({ runId: 'recovery', leaseEpoch: 2 })).kind, 'observed');
    assert.deepEqual(trace, ['recovery-fence', 'resume']);
  } finally { await manager.shutdownAll(); }
});
