import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { runFixture } from './fixtures/automation';
const managers: TerminalManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdownAll(); });
import { TerminalManager } from '../src/lib/terminal/terminal-manager';
import { createAutomationRuntime } from '../src/lib/automation/runtime-adapter';
import type { AutomationAuthority, Boundary } from '../src/lib/automation/runtime-port';
import type { SessionSelectionSnapshot } from '../src/lib/automation/contracts';

const selection: SessionSelectionSnapshot = { provider: 'codex', model: null,
  reasoningEffort: null, serviceTier: null,
  settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } };
async function fixture(provider: 'codex' | 'claude-code' = 'codex') {
  const writes: string[] = [];
  const exits: Array<(event: { exitCode: number }) => void> = [];
  const events: string[] = [];
  const manager = new TerminalManager(() => {}, async () => ({ spawn: () => ({
    write: (data: string) => { writes.push(data); }, resize() {}, kill() { for (const exit of exits) exit({ exitCode: 0 }); }, onData() {}, onExit(listener: (event: { exitCode: number }) => void) { exits.push(listener); },
  }) }), undefined, { semanticPromptSubmitDelayMs: 15 });
  managers.push(manager);
  const boundaries: Boundary[] = [];
  const authority = {
    loadRun: () => ({ run: { ...runFixture(), id: "run", automationId: "rule", sessionId: "session", effectiveSelection: { ...selection, provider } }, target: { kind: "wake-session", sessionId: "session" }, prompt: "Continue safely", ownerUserId: "owner" }),
    recordBoundary: ({ boundary }) => { boundaries.push(boundary); },
    recordRuntimeObservation() {}, recordInputOwnership() {}, pauseWake() {},
    recordOutcome: (_id, result) => { events.push(result.kind); },
    beginAttempt: (runId, leaseEpoch) => ({ runId, leaseEpoch, token: 'permit' }),
    withWriteFence: (_permit, phase, write) => { events.push(phase); write(); },
  } as AutomationAuthority;
  const runtime = createAutomationRuntime({ manager, authority: () => authority,
    readSelection: async () => ({ ...selection, provider }) });
  await manager.create({ userId: 'owner', sessionId: 'session', terminalId: 'terminal',
    connectionId: 'panel', surfaceId: 'normal', providerId: provider, agentEnvironment: 'wsl',
    resolvedShell: { command: 'fixture', args: [], cwd: process.cwd() } });
  let time = Date.now();
  const hook = (hookEvent: string, status: 'running' | 'completed' | 'input_required' | 'idle') =>
    manager.recordSessionState({ type: 'session_state', sessionId: 'session', terminalId: 'terminal',
      hookEvent, status, stateAt: ++time }, 'owner');
  const arm = () => runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule',
    selection: { ...selection, provider } }, () => {});
  return { manager, runtime, writes, events, authority, boundaries, hook, arm };
}

test('a visible completed Session can arm, rejects human bytes, and pause restores current epoch input', async () => {
  const f = await fixture();
  f.hook('SessionStart', 'idle');
  await assert.rejects(f.arm(), /boundary/i);
  f.hook('UserPromptSubmit', 'running');
  f.hook('Stop', 'completed');
  const ownership = await f.arm();
  assert.equal(ownership.mode, 'armed');
  assert.throws(() => f.manager.write('terminal', 'owner', 'panel', 'normal', 'draft'), /automation/i);
  await assert.rejects(f.manager.sendSessionKeys('session', 'owner', ['escape']), /automation/i);
  await assert.rejects(f.manager.submitSessionPrompt('session', 'owner', 'manual'), /automation/i);
  assert.deepEqual(f.writes, []);
  const human = f.runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' });
  assert.equal(human.mode, 'human');
  assert.throws(() => f.manager.write('terminal', 'owner', 'panel', 'normal', 'stale', ownership.epoch), /epoch/i);
  f.manager.write('terminal', 'owner', 'panel', 'normal', 'ok', human.epoch);
  assert.deepEqual(f.writes, ['ok']);
});

for (const provider of ['claude-code', 'codex'] as const) {
  test(`${provider}: visible wake writes once, pause drains delayed Enter, duplicate dispatch cannot resend`, async () => {
    const f = await fixture(provider);
    f.hook('UserPromptSubmit', 'running');
    let boundary: Boundary | null = null;
    f.hook('Stop', 'completed');
    await f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection: { ...selection, provider } }, (evidence) => {
      if (evidence.kind === 'completed') boundary = evidence.boundary;
    });
    const args = { runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary };
    const delivery = f.runtime.dispatch(args);
    await new Promise(resolve => setTimeout(resolve, 3));
    assert.equal(f.runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' }).mode, 'draining');
    assert.throws(() => f.manager.write('terminal', 'owner', 'panel', 'normal', 'human'), /automation/i);
    assert.equal((await delivery).kind, 'delivered');
    assert.deepEqual(f.writes, ['\x1b[200~Continue safely\x1b[201~', '\r']);
    assert.equal(f.runtime.ownership('owner', 'session').mode, 'human');
    await f.runtime.dispatch(args);
    assert.equal(f.writes.length, 2);
    assert.deepEqual(f.events, ['begin', 'complete', 'delivered']);
  });
}

test('permission during paste keeps unknown input locked until quiescent acknowledgement; no Enter or retry', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running');
  f.hook('Stop', 'completed');
  let boundary: Boundary | null = null;
  await f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => {
    if (evidence.kind === 'completed') boundary = evidence.boundary;
  });
  const args = { runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary };
  const pending = f.runtime.dispatch(args);
  await new Promise(resolve => setTimeout(resolve, 3));
  f.hook('PermissionRequest', 'input_required');
  assert.throws(() => f.runtime.releaseRecovery({ userId: 'owner', sessionId: 'session', runId: 'run' }, () => {}));
  assert.equal((await pending).kind, 'unknown');
  assert.equal(f.runtime.ownership('owner', 'session').mode, 'recovery-required');
  assert.throws(() => f.runtime.releaseRecovery({ userId: 'owner', sessionId: 'session', runId: 'run' }, () => { throw Error('persistence'); }));
  assert.equal(f.runtime.releaseRecovery({ userId: 'owner', sessionId: 'session', runId: 'run' }, () => {}).mode, 'human');
  await f.runtime.dispatch(args);
  assert.equal(f.writes.length, 1);
});

test('raw draft and an in-flight human semantic paste prevent takeover; failed arm commit releases input', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running');
  f.hook('Stop', 'completed');
  await assert.rejects(f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, () => { throw Error('rollback'); }));
  assert.equal(f.runtime.ownership('owner', 'session').mode, 'human');
  f.manager.write('terminal', 'owner', 'panel', 'normal', 'unsent');
  await assert.rejects(f.arm());
  const sending = f.manager.submitSessionPrompt('session', 'owner', 'human');
  await assert.rejects(f.arm());
  await sending;
  assert.equal(f.writes.at(-1), '\r');
});

test('permission without an active writer pauses and permits manual approval after drain', async () => {
  const f = await fixture();
  f.authority.pauseWake = (userId, sessionId) => { f.runtime.drain({ userId, sessionId, automationId: 'rule' }); };
  f.hook('UserPromptSubmit', 'running');
  await f.arm();
  f.hook('PermissionRequest', 'input_required');
  assert.equal(f.runtime.ownership('owner', 'session').mode, 'human');
});

test('late submit/Stop hooks cannot clean an unsent PTY draft', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running');
  f.manager.write('terminal', 'owner', 'panel', 'normal', 'unsent');
  f.hook('UserPromptSubmit', 'running');
  f.hook('Stop', 'completed');
  await assert.rejects(f.arm());
});

test('raw input receipts reject armed/stale/detached requests and acknowledge current human bytes', async () => {
  const { writeTerminalInput } = await import('../src/lib/terminal/terminal-input-receipt');
  const f = await fixture();
  const request = { requestId: 'raw', terminalId: 'terminal', surfaceId: 'normal', data: 'draft' };
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  const armed = await f.arm();
  assert.equal(writeTerminalInput(f.manager, 'owner', 'panel', request).code, 'INPUT_OWNED_BY_AUTOMATION');
  const human = f.runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' });
  assert.equal(writeTerminalInput(f.manager, 'owner', 'panel', { ...request, inputEpoch: armed.epoch }).code, 'INPUT_OWNERSHIP_STALE');
  assert.equal(writeTerminalInput(f.manager, 'owner', 'other', { ...request, inputEpoch: human.epoch }).outcome, 'rejected');
  assert.equal(writeTerminalInput(f.manager, 'owner', 'panel', { ...request, inputEpoch: human.epoch }).outcome, 'accepted');
  assert.deepEqual(f.writes, ['draft']);
});

test('arming reserves the gate during the synchronous commit and rolls back exactly on failure', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  const before = f.runtime.ownership('owner', 'session');
  await assert.rejects(f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, () => {
    assert.throws(() => f.manager.write('terminal', 'owner', 'panel', 'normal', 'race'), /automation/i);
    throw Error('rollback');
  }));
  assert.deepEqual(f.runtime.ownership('owner', 'session'), before);
  assert.deepEqual(f.writes, []);
});

test('a duplicate old submit does not create a fresh occurrence, and late Stop cannot complete a new unconfirmed send', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  let boundary: Boundary | null = null;
  await f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => {
    if (evidence.kind === 'completed') boundary = evidence.boundary;
  });
  f.hook('UserPromptSubmit', 'running');
  f.hook('Stop', 'completed');
  assert.equal(f.boundaries.length, 0);
  assert.equal((await f.runtime.dispatch({ runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary })).kind, 'delivered');
  f.hook('Stop', 'completed');
  assert.equal(f.boundaries.length, 0, 'next completion requires the next provider submission hook');
});

test('known Codex children hold the lead boundary until their accepted completion, unknown origin cannot arm', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running');
  f.manager.recordAutomationBackground('terminal', 'owner', 'session', 'child', 'active');
  f.hook('Stop', 'completed');
  await assert.rejects(f.arm());
  f.manager.recordAutomationBackground('terminal', 'owner', 'session', 'child', 'clear');
  assert.equal((await f.arm()).mode, 'armed');
  f.runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' });
  f.manager.recordAutomationBackground('terminal', 'owner', 'session', 'unknown', 'unknown');
  await assert.rejects(f.arm());
});

test('explicit stop inhibits automation and waits for its active writer before closing the Session', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  let boundary: Boundary | null = null;
  await f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => {
    if (evidence.kind === 'completed') boundary = evidence.boundary;
  });
  const sending = f.runtime.dispatch({ runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary });
  await new Promise(resolve => setTimeout(resolve, 3));
  const stopped = f.manager.stopSessionRuntime('session', 'owner');
  assert.equal(f.runtime.ownership('owner', 'session').mode, 'draining');
  assert.equal((await sending).kind, 'delivered');
  assert.equal((await stopped).runtimeState, 'exited');
  assert.deepEqual(f.writes, ['\x1b[200~Continue safely\x1b[201~', '\r']);
});
