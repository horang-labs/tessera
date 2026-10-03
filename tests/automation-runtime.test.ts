import { ClaudeHookLifecycleTracker, classifyClaudeAutomationCompletion } from '../src/lib/cli/providers/claude-code/terminal-hook-lifecycle';
import { hookSubmissionFixture } from './fixtures/autorun-contracts';
import { classifyCodexAutomationCompletion } from '../src/lib/cli/providers/codex/terminal-hook-lifecycle';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runFixture } from './fixtures/automation';
const managers: TerminalManager[] = [];
let previousDataDir: string | undefined, dataDir: string;
beforeEach(async () => {
  previousDataDir = process.env.TESSERA_DATA_DIR;
  await fs.mkdir('tmp', { recursive: true });
  dataDir = await fs.mkdtemp(path.resolve('tmp/automation-runtime-'));
  process.env.TESSERA_DATA_DIR = dataDir;
});
afterEach(async () => {
  try { for (const manager of managers.splice(0)) await manager.shutdownAll(); }
  finally {
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true });
  }
});
import { TerminalManager } from '../src/lib/terminal/terminal-manager';
import { createAutomationRuntime } from '../src/lib/automation/runtime-adapter';
import type { AutomationAuthority, Boundary } from '../src/lib/automation/runtime-port';
import type { SessionSelectionSnapshot } from '../src/lib/automation/contracts';

async function waitForPaste(writes: string[]) {
  const deadline = Date.now() + 1000;
  while (!writes.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(writes.length, 1, 'dispatch reached its actual paste boundary');
}
const selection: SessionSelectionSnapshot = { provider: 'codex', model: null,
  reasoningEffort: null, serviceTier: null,
  settings: { permissionPolicy: 'inherit-cli', allowPreparationFailure: false } };
async function fixture(provider: 'codex' | 'claude-code' = 'codex', beforeSelectionRead?: () => Promise<void>) {
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
    readSelection: async () => { await beforeSelectionRead?.(); return { ...selection, provider }; } });
  await manager.create({ userId: 'owner', sessionId: 'session', terminalId: 'terminal',
    connectionId: 'panel', surfaceId: 'normal', providerId: provider, agentEnvironment: 'wsl',
    resolvedShell: { command: 'fixture', args: [], cwd: process.cwd() } });
  let time = Date.now();
  const hook = (hookEvent: string, status: 'running' | 'completed' | 'input_required' | 'idle', children = false) =>
    manager.recordSessionState({ type: 'session_state', sessionId: 'session', terminalId: 'terminal',
      hookEvent, status, stateAt: ++time, hasWorkingSubagents: children }, 'owner', provider === 'claude-code'
      ? classifyClaudeAutomationCompletion(hookEvent, status) : classifyCodexAutomationCompletion(hookEvent, status));
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
    await waitForPaste(f.writes);
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
  await waitForPaste(f.writes);
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
  await waitForPaste(f.writes);
  const stopped = f.manager.stopSessionRuntime('session', 'owner');
  assert.equal(f.runtime.ownership('owner', 'session').mode, 'draining');
  assert.equal((await sending).kind, 'delivered');
  assert.equal((await stopped).runtimeState, 'exited');
  assert.deepEqual(f.writes, ['\x1b[200~Continue safely\x1b[201~', '\r']);
});


test('a failed lead turn stays ineligible after Claude children finish', async () => {
  const f = await fixture('claude-code');
  f.hook('UserPromptSubmit', 'running');
  await f.arm();
  const lifecycle = new ClaudeHookLifecycleTracker();
  lifecycle.apply('terminal', 'UserPromptSubmit', {});
  const child = { agent_id: 'child' };
  for (const event of ['SubagentStart', 'StopFailure', 'SubagentStop']) {
    const mapped = lifecycle.apply('terminal', event, child)!;
    f.hook(event, mapped.status, lifecycle.hasWorkingSubagents('terminal'));
  }
  assert.deepEqual(f.boundaries, []);
  assert.notEqual(f.runtime.ownership('owner', 'session').mode, 'armed');
});


test('an unpersisted completion disarms and cannot become a remembered wake occurrence', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running');
  await f.arm();
  f.authority.recordBoundary = () => { throw Error('storage unavailable'); };
  assert.doesNotThrow(() => f.hook('Stop', 'completed'));
  assert.notEqual(f.runtime.ownership('owner', 'session').mode, 'armed');
  await assert.rejects(f.arm());
  f.hook('Stop', 'completed');
  assert.deepEqual(f.boundaries, []);
});

test('completion without the durable authority fails closed', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running');
  await f.arm();
  f.manager.automation.authority = () => null;
  f.hook('Stop', 'completed');
  assert.notEqual(f.runtime.ownership('owner', 'session').mode, 'armed');
  assert.throws(() => f.manager.write('terminal', 'owner', 'panel', 'normal', 'race'), /automation/i);
  assert.deepEqual(f.boundaries, []);
});


test('a busy admission defers without an attempt, then retries the same run exactly once', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  let boundary: Boundary | null = null;
  await f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => {
    if (evidence.kind === 'completed') boundary = evidence.boundary;
  });
  let attempts = 0;
  const beginAttempt = f.authority.beginAttempt;
  f.authority.beginAttempt = (...args) => { attempts++; return beginAttempt(...args); };
  const args = { runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary };
  // Another admitted writer holds the shared Session mutex, without external bytes yet.
  f.manager.automation.writer('owner', 'session', true);
  const deferred = await f.runtime.dispatch(args);
  assert.equal(deferred.kind, 'deferred');
  if (deferred.kind === 'deferred') assert.ok(deferred.retryAt > Date.now());
  assert.equal(attempts, 0);
  assert.deepEqual(f.writes, []);
  f.manager.automation.writer('owner', 'session', false);
  assert.equal((await f.runtime.dispatch(args)).kind, 'delivered');
  assert.equal((await f.runtime.dispatch(args)).kind, 'delivered');
  assert.equal(attempts, 1);
  assert.deepEqual(f.writes, ['\x1b[200~Continue safely\x1b[201~', '\r']);
});


test('Claude child work blocks arming until a successful lead and child drain settle', async () => {
  const f = await fixture('claude-code');
  f.hook('UserPromptSubmit', 'running');
  f.hook('SubagentStart', 'running', true);
  await assert.rejects(f.arm());
  f.hook('Stop', 'running', true);
  await assert.rejects(f.arm());
  f.hook('SubagentStop', 'completed');
  assert.equal((await f.arm()).mode, 'armed');
});


test('post-Enter observation failure preserves the accepted Chat receipt and same-ID retry cannot resend', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  f.authority.recordRuntimeObservation = () => { throw Error('observation storage unavailable'); };
  try {
    const accepted = await f.manager.submitSessionChatPrompt('session', 'owner', 'Human follow-up', 'same-id');
    const retried = await f.manager.submitSessionChatPrompt('session', 'owner', 'Human follow-up', 'same-id');
    assert.deepEqual(retried, accepted);
    assert.deepEqual(f.writes, ['\x1b[200~Human follow-up\x1b[201~', '\r']);
  } finally { f.authority.recordRuntimeObservation = () => {}; }
});


test('post-Enter observation failure cannot turn a delivered automated wake into unknown', async () => {
  const f = await fixture();
  f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
  let boundary: Boundary | null = null;
  await f.runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => {
    if (evidence.kind === 'completed') boundary = evidence.boundary;
  });
  f.authority.recordRuntimeObservation = () => { throw Error('observation storage unavailable'); };
  try {
    const args = { runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary };
    assert.equal((await f.runtime.dispatch(args)).kind, 'delivered');
    assert.equal((await f.runtime.dispatch(args)).kind, 'delivered');
    assert.deepEqual(f.writes, ['\x1b[200~Continue safely\x1b[201~', '\r']);
  } finally { f.authority.recordRuntimeObservation = () => {}; }
});

for (const surfaceId of ['normal', 'peek']) {
  test(`automatic terminal replies preserve accepted native proof on ${surfaceId}`, async () => {
    const f = await fixture();
    if (surfaceId === 'peek') await f.manager.create({ userId: 'owner', sessionId: 'session', terminalId: 'terminal',
      connectionId: 'panel', surfaceId, providerId: 'codex', agentEnvironment: 'wsl',
      resolvedShell: { command: 'fixture', args: [], cwd: process.cwd() } });
    f.manager.activateProviderSessionIdentity('terminal', 'owner', 'conversation-1');
    const write = (data: string) => f.manager.write('terminal', 'owner', 'panel', surfaceId, data);
    const read = () => f.manager.automation.readTurnEvidence({ userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl' });
    const submission = { ...hookSubmissionFixture(), userId: 'owner', sessionId: 'session', terminalId: 'terminal' };
    submission.evidence.serverInstanceId = f.manager.automation.serverInstanceId;
    write('Read stage-one.txt'); write('\r');
    // Automatic focus changes can arrive between Enter and native Submit.
    write('\x1b[O');
    f.hook('UserPromptSubmit', 'running');
    assert.equal(f.manager.automation.recordHookEvidence(submission).kind, 'accepted');
    assert.equal(read().kind, 'running');
    write('\x1b[1;1R');
    assert.equal(read().kind, 'running');
    f.hook('Stop', 'completed');
    assert.equal(f.manager.automation.recordHookEvidence({ ...submission, kind: 'completion',
      evidence: { ...submission.evidence, completionHookId: 'stop-1', dedupKey: 'stop-1' } }).kind, 'accepted');
    const completed = read();
    assert.equal(completed.kind, 'completed');
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x1b\\']) {
      assert.equal(write(reply), true);
      assert.deepEqual(read(), completed);
      assert.equal(f.writes.at(-1), reply, 'reply still reaches the PTY unchanged');
    }
    write('\x1b[Ounsent');
    assert.deepEqual(read(), { kind: 'idle', reason: 'no-accepted-turn' });
    await assert.rejects(f.arm(), /boundary/i);
    assert.equal(f.manager.automation.recordHookEvidence(submission).kind, 'rejected');
  });
}

for (const surfaceId of ['normal', 'peek']) {
  test(`${surfaceId} retained draft veto prevents continuation after arm and invalidates a pending submit even if cleared`, async () => {
    for (const timing of ['before', 'during']) {
      const f = await fixture();
      f.hook('UserPromptSubmit', 'running'); f.hook('Stop', 'completed');
      let boundary: Boundary | null = null;
      await f.runtime.arm({userId:'owner',sessionId:'session',automationId:'rule',selection}, e => {
        if (e.kind === 'completed') boundary = e.boundary;
      });
      const scope = {userId:'owner',sessionId:'session',agentEnvironment:'wsl' as const};
      if (timing === 'before') f.runtime.activation!.setDraftVeto(scope,{surfaceId,revision:1,hasDraft:true});
      const pending = f.runtime.dispatch({runId:'run',leaseEpoch:1,expectedRevision:1,expectedBoundary:boundary});
      if (timing === 'during') {
        await waitForPaste(f.writes);
        f.runtime.activation!.setDraftVeto(scope,{surfaceId,revision:1,hasDraft:true});
        f.runtime.activation!.setDraftVeto(scope,{surfaceId,revision:2,hasDraft:false});
      }
      const outcome = await pending;
      assert.equal(outcome.kind,timing === 'before' ? 'cancelled' : 'unknown');
      assert.equal(f.writes.length,timing === 'before' ? 0 : 1);
      assert.ok(!f.writes.includes('\r'),'a retained draft edit must not be submitted');
    }
  });
}

for (const surfaceId of ['normal', 'peek']) {
  test(`${surfaceId} cleared draft during asynchronous selection invalidates queued continuation before paste`, async () => {
    let wait=false, entered!:()=>void, release!:()=>void;
    const pendingRead = new Promise<void>(resolve=>{release=resolve;});
    const reading = new Promise<void>(resolve=>{entered=resolve;});
    const f=await fixture('codex',async()=>{if(wait){entered();await pendingRead;}});
    f.hook('UserPromptSubmit','running'); f.hook('Stop','completed');
    let boundary:Boundary|null=null;
    await f.runtime.arm({userId:'owner',sessionId:'session',automationId:'rule',selection},e=>{if(e.kind==='completed')boundary=e.boundary;});
    wait=true;
    const pending=f.runtime.dispatch({runId:'run',leaseEpoch:1,expectedRevision:1,expectedBoundary:boundary});
    await reading;
    const scope={userId:'owner',sessionId:'session',agentEnvironment:'wsl' as const};
    f.runtime.activation!.setDraftVeto(scope,{surfaceId,revision:1,hasDraft:true});
    f.runtime.activation!.setDraftVeto(scope,{surfaceId,revision:2,hasDraft:false});
    release(); assert.equal((await pending).kind,'cancelled'); assert.deepEqual(f.writes,[]);
  });
}
