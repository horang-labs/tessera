import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getNativeAutomationInteraction } from '@/lib/automation/native-interaction';
import type { TerminalPtyFactory } from '@/lib/terminal/types';
import { mintPaneToken } from '@/lib/terminal/pane-token-registry';
import { buildAutorunHookEvidence } from '@/lib/cli/providers/autorun-hook-evidence';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-native-interaction-'));
process.env.NODE_ENV = 'test';
let TerminalManager: typeof import('@/lib/terminal/terminal-manager').TerminalManager;
const workspace = mkdtempSync(path.join(tmpdir(), 'tessera-native-workspace-'));
before(async () => {
  const [{ initDatabase }, { registerProject }, { createSession }, terminal] = await Promise.all([
    import('@/lib/db/database'), import('@/lib/db/projects'), import('@/lib/db/sessions'), import('@/lib/terminal/terminal-manager'),
  ]);
  await initDatabase(); registerProject('native-project', workspace, 'Native project');
  createSession('worker', 'native-project', 'worker', 'codex', { workDir: workspace });
  const [{ cliProviderRegistry }, { codexAdapter }] = await Promise.all([import('@/lib/cli/providers/registry'), import('@/lib/cli/providers/codex/adapter')]);
  cliProviderRegistry.register('codex', codexAdapter);
  TerminalManager = terminal.TerminalManager;
});
const screen = '\x1b[2J\x1b[4;1H\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m'
  + '\x1b[6;1H? for shortcuts\x1b[4;3H';
async function setup(withIdleHook = true, authenticated = true) {
  const writes: string[] = []; let output: (data: string) => void = () => {};
  const factory: TerminalPtyFactory = { spawn: () => ({ write: data => writes.push(data), resize: () => {}, kill: () => {},
    onData: cb => { output = cb; }, onExit: () => {} }) };
  const manager = new TerminalManager(() => {}, async () => factory, undefined, {
    semanticPromptSubmitDelayMs: 0, nativeProviderVersion: async () => '0.159.2',
  });
  const paneToken = authenticated ? mintPaneToken({ terminalId: 'terminal', userId: 'owner', sessionId: 'worker', providerId: 'codex' }) : undefined;
  await manager.startDetached({ paneToken, terminalId: 'terminal', userId: 'owner', sessionId: 'worker', cwd: workspace,
    connectionId: 'test', surfaceId: 'test', cols: 80, rows: 12, providerId: 'codex', agentEnvironment: 'wsl' });
  if (withIdleHook) manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
    status: 'idle', hookEvent: 'SessionStart', stateAt: Date.now() }, 'owner');
  output(screen); await new Promise<void>(resolve => setImmediate(resolve));
  return { manager, writes, output, port: getNativeAutomationInteraction(manager) };
}

test('real gate claim preserves ready identity and fences bootstrap on the same native worker', async () => {
  const { manager, port, writes } = await setup();
  try {
    assert.ok(port, 'actual manager must bind its native port');
    const ready = await port.observe({ userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' });
    assert.equal(ready.kind, 'ready', JSON.stringify(ready)); if (ready.kind !== 'ready') return;
    manager.automation.claimNativeAction(ready.identity, 'rule', 'run');
    assert.doesNotThrow(() => port.assertCurrent(ready));
    const result = await port.submitPrompt({ expected: ready, prompt: 'Read marker.txt', submissionId: 'run',
      signal: new AbortController().signal, writeFence: (_phase, write) => {
        manager.automation.verifyNativeAction(ready.identity, 'rule', 'run'); port.assertCurrent(ready); write();
      } });
    assert.equal(result.kind, 'delivered');
    assert.deepEqual(writes, ['\x1b[200~Read marker.txt\x1b[201~', '\r']);
    assert.throws(() => port.assertCurrent(ready));
  } finally { await manager.shutdownAll(); }
});

test('human native edits, retained surface drafts and changed output invalidate ready tokens', async () => {
  const { manager, port, output } = await setup();
  try {
    assert.ok(port); const scope = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' as const };
    const first = await port.observe(scope); assert.equal(first.kind, 'ready'); if (first.kind !== 'ready') return;
    await manager.sendSessionKeys('worker', 'owner', ['escape']);
    assert.throws(() => port.assertCurrent(first));
    const fresh = await port.observe(scope); assert.equal(fresh.kind, 'ready'); if (fresh.kind !== 'ready') return;
    manager.automation.setDraftVeto('owner', 'worker', { surfaceId: 'peek', revision: 1, hasDraft: true });
    assert.equal((await port.observe(scope)).kind, 'draft'); assert.throws(() => port.assertCurrent(fresh));
    manager.automation.setDraftVeto('owner', 'worker', { surfaceId: 'peek', revision: 2, hasDraft: false });
    output('\x1b[4;3Hnative draft'); await new Promise<void>(resolve => setImmediate(resolve));
    assert.throws(() => port.assertCurrent(fresh)); assert.equal((await port.observe(scope)).kind, 'draft');
  } finally { await manager.shutdownAll(); }
});

test('correlated native approval preserves accepted lead through gate claim and response pipe receipt', async () => {
  const { manager, port, writes } = await setup();
  try {
    assert.ok(port); manager.activateProviderSessionIdentity('terminal', 'owner', 'native');
    let reservedFinalResponse = false;
    manager.automation.authority = () => ({ canSuperviseNativeApproval: (scope: { request?: import('@/lib/automation/activation-contracts').NativeApprovalRequest }) =>
      !reservedFinalResponse || scope.request?.requestId === 'approval',
      recordRuntimeObservation: () => {}, recordInputOwnership: () => {}, pauseWake: () => {},
    } as import('@/lib/automation/runtime-port').AutomationAuthority);
    const at = Date.now() + 1000;
    manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
      status: 'running', hookEvent: 'UserPromptSubmit', stateAt: at }, 'owner');
    const state = manager.automation.readNativeState('owner', 'worker')!;
    const evidence = { provider: 'codex' as const, providerConversationId: 'native', nativeTurnId: 'turn',
      observerSubmissionId: 'submit', serverInstanceId: state.identity.serverInstanceId, terminalGeneration: state.identity.generation,
      sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'file', startByte: 0, dedupKey: 'submit' };
    assert.equal(manager.automation.recordHookEvidence({ kind: 'submission', userId: 'owner', sessionId: 'worker',
      terminalId: 'terminal', agentEnvironment: 'wsl', observedAt: at, evidence }).kind, 'accepted');
    const payload = { hook_event_name: 'PermissionRequest', session_id: 'native', turn_id: 'turn', tool_name: 'exec_command',
      tool_input: { command: 'cat marker.txt' }, cwd: workspace,
      tessera_native_approval: { invocationId: 'approval', generation: state.identity.generation, providerVersion: '0.159.2' },
      tessera_autorun: { observerSubmissionId: 'submit', sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'file', nativeId: 'turn' } };
    const offer = manager.openNativeApproval('terminal', 'owner', payload); assert.ok(offer);
    assert.equal(manager.automation.readNativeState('owner', 'worker')?.state, 'input-required',
      'an authenticated held PermissionRequest is the native approval input boundary');
    const interaction = await port.observe({ userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' });
    assert.equal(interaction.kind, 'approval'); if (interaction.kind !== 'approval') return;
    assert.throws(() => port.assertCurrent({ ...interaction.request, requestHash: 'b'.repeat(64) }));
    manager.automation.setDraftVeto('owner', 'worker', { surfaceId: 'peek', revision: 1, hasDraft: true });
    assert.throws(() => port.assertCurrent(interaction.request));
    manager.automation.setDraftVeto('owner', 'worker', { surfaceId: 'peek', revision: 2, hasDraft: false });
    manager.automation.claimNativeAction(interaction.request.identity, 'rule', 'approval-run');
    reservedFinalResponse = true; // External authority has charged its final reserved attempt.
    assert.equal(manager.automation.canSuperviseNativeApproval('owner', 'worker'), false, 'new admission is exhausted');
    const result = port.respondApproval({ expected: interaction.request, optionId: 'allow-once', signal: new AbortController().signal,
      writeFence: (_phase, write) => { manager.automation.verifyNativeAction(interaction.request.identity, 'rule', 'approval-run');
        port.assertCurrent(interaction.request); write(); } });
    await offer;
    assert.equal(manager.nativeApprovals.commit('approval', interaction.request.requestHash, output => {
      assert.equal(output.hookSpecificOutput.decision.behavior, 'allow');
    }), true);
    assert.equal(manager.nativeApprovals.acknowledge('approval', interaction.request.requestHash), true);
    assert.equal((await result).kind, 'delivered'); assert.deepEqual(writes, []);
    manager.automation.writer('owner', 'worker', false);
    const retained = manager.automation.readTurnEvidence({ userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' });
    assert.equal(retained.kind, 'running'); if (retained.kind === 'running') assert.deepEqual(retained.submission, evidence);
    reservedFinalResponse = false; // Separate manual-defer scenario has available admission.
    const manual = manager.openNativeApproval('terminal', 'owner', { ...payload,
      tessera_native_approval: { ...payload.tessera_native_approval, invocationId: 'manual' } });
    assert.ok(manual); assert.equal(typeof port.deferApproval, 'function');
    const waiting = await port.observe({ userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' });
    assert.equal(waiting.kind, 'approval'); if (waiting.kind !== 'approval') return;
    const scope = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' as const };
    port.deferApproval!({ scope, expected: { ...waiting.request, requestHash: 'b'.repeat(64) } });
    assert.equal(manager.nativeApprovals.current('owner', 'worker')?.requestId, 'manual');
    port.deferApproval!({ scope, expected: waiting.request });
    assert.equal(await manual, null); assert.equal(manager.automation.readNativeState('owner', 'worker')?.nativeApprovalId, null);
  } finally { await manager.shutdownAll(); }
});

test('native Stop invalidates a correlated pending approval before any response', async () => {
  const { manager, port, writes } = await setup();
  try {
    assert.ok(port); manager.activateProviderSessionIdentity('terminal', 'owner', 'native');
    manager.automation.authority = () => ({ canSuperviseNativeApproval: () => true,
      recordRuntimeObservation: () => {}, recordInputOwnership: () => {}, pauseWake: () => {},
    } as import('@/lib/automation/runtime-port').AutomationAuthority);
    const at = Date.now() + 1000;
    manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
      status: 'running', hookEvent: 'UserPromptSubmit', stateAt: at }, 'owner');
    const state = manager.automation.readNativeState('owner', 'worker')!;
    const evidence = { provider: 'codex' as const, providerConversationId: 'native', nativeTurnId: 'turn',
      observerSubmissionId: 'submit', serverInstanceId: state.identity.serverInstanceId, terminalGeneration: state.identity.generation,
      sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'file', startByte: 0, dedupKey: 'submit' };
    assert.equal(manager.automation.recordHookEvidence({ kind: 'submission', userId: 'owner', sessionId: 'worker',
      terminalId: 'terminal', agentEnvironment: 'wsl', observedAt: at, evidence }).kind, 'accepted');
    const payload = { hook_event_name: 'PermissionRequest', session_id: 'native', turn_id: 'turn', tool_name: 'exec_command',
      tool_input: { command: 'cat marker.txt' }, cwd: workspace,
      tessera_native_approval: { invocationId: 'approval', generation: state.identity.generation, providerVersion: '0.159.2' },
      tessera_autorun: { observerSubmissionId: 'submit', sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'file', nativeId: 'turn' } };
    const offer = manager.openNativeApproval('terminal', 'owner', payload); assert.ok(offer);
    const interaction = await port.observe({ userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' });
    assert.equal(interaction.kind, 'approval'); if (interaction.kind !== 'approval') return;
    manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
      status: 'completed', hookEvent: 'Stop', stateAt: at + 1000 }, 'owner');
    assert.equal(manager.automation.readNativeState('owner', 'worker')?.state, 'turn-complete');
    assert.throws(() => port.assertCurrent(interaction.request), 'completed lifecycle must invalidate request');
  } finally { await manager.shutdownAll(); }
});

// Actual packaged e065: native trust accepted, clean Codex prompt, but no initial lifecycle hook/turn.
test('authenticated fresh native empty prompt can bootstrap while gate still reports starting', async () => {
  const { manager, port, writes } = await setup(false);
  try {
    assert.ok(port); assert.equal(manager.automation.readNativeState('owner', 'worker')?.state, 'starting');
    const scope = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' as const };
    assert.equal(manager.automation.readTurnEvidence(scope).kind, 'idle');
    const ready = await port.observe(scope); assert.equal(ready.kind, 'ready'); if (ready.kind !== 'ready') return;
    assert.equal(ready.identity.providerConversationId, null);
    manager.automation.claimNativeAction(ready.identity, 'rule', 'run');
    const result = await port.submitPrompt({ expected: ready, prompt: 'Read marker.txt', submissionId: 'run',
      signal: new AbortController().signal, writeFence: (_phase, write) => {
        manager.automation.verifyNativeAction(ready.identity, 'rule', 'run'); port.assertCurrent(ready); write();
      } });
    assert.equal(result.kind, 'delivered'); assert.equal(writes.length, 2);
  } finally { await manager.shutdownAll(); }
});

test('starting state preserves trust/menu/draft and unrelated-shell vetoes', async () => {
  for (const authenticated of [true, false]) {
    const { manager, port, output } = await setup(false, authenticated);
    try {
      assert.ok(port); const scope = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' as const };
      if (!authenticated) { assert.equal((await port.observe(scope)).kind, 'starting'); continue; }
      output('\x1b[2J\x1b[4;1HDo you trust this folder?\x1b[6;1H1. Yes\x1b[6;3H');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await port.observe(scope)).kind, 'starting');
      output(screen + '\x1b[4;1H\x1b[2m›\x1b[0m\x1b[4;3H');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await port.observe(scope)).kind, 'starting');
      output(screen + '\x1b[4;3H\x1b[0munsent draft');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await port.observe(scope)).kind, 'draft');
      output(screen); manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
        status: 'running', hookEvent: 'UserPromptSubmit', stateAt: Date.now() }, 'owner');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await port.observe(scope)).kind, 'running');
    } finally { await manager.shutdownAll(); }
  }
});

test('late startup hooks do not prevent a current empty native prompt after model recovery', async () => {
  const { manager, port, output } = await setup(false);
  try {
    assert.ok(port); const scope = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' as const };
    const first = await port.observe(scope); assert.equal(first.kind, 'ready'); if (first.kind !== 'ready') return;
    manager.automation.claimNativeAction(first.identity, 'rule', 'first');
    assert.equal((await port.submitPrompt({ expected: first, prompt: 'Read marker.txt', submissionId: 'first',
      signal: new AbortController().signal, writeFence: (_phase, write) => {
        manager.automation.verifyNativeAction(first.identity, 'rule', 'first'); port.assertCurrent(first); write();
      } })).kind, 'delivered');
    manager.automation.writer('owner', 'worker', false);
    manager.automation.drain('owner', 'worker', 'rule'); // Exhausted first dispatch returns human input.
    const at = Date.now() + 1000;
    for (const [hookEvent, status] of [['SessionStart', 'idle'], ['UserPromptSubmit', 'running']] as const)
      manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
        hookEvent, status, stateAt: at + (status === 'running' ? 1 : 0) }, 'owner');
    manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
      hookEvent: 'InterruptFallback', status: 'idle', stateAt: at + 2 }, 'owner');
    assert.equal(manager.automation.readNativeState('owner', 'worker')?.state, 'unknown');
    // Native HTTP400/model-selection output is history; the actual input frame is empty again.
    output(screen); await new Promise<void>(resolve => setImmediate(resolve));
    const ready = await port.observe(scope); assert.equal(ready.kind, 'ready'); if (ready.kind !== 'ready') return;
    manager.automation.claimNativeAction(ready.identity, 'rule', 'retry');
    assert.doesNotThrow(() => port.assertCurrent(ready));
    assert.equal(manager.automation.readTurnEvidence(scope).kind, 'unavailable', 'no completion is invented');
    manager.automation.writer('owner', 'worker', false);
    output(screen + '\x1b[4;3H\x1b[0munsent draft'); await new Promise<void>(resolve => setImmediate(resolve));
    assert.throws(() => port.assertCurrent(ready));
    assert.equal((await port.observe(scope)).kind, 'draft');
    output(screen); await new Promise<void>(resolve => setImmediate(resolve));
    const retry = await port.observe(scope); assert.equal(retry.kind, 'ready'); if (retry.kind !== 'ready') return;
    manager.automation.claimNativeAction(retry.identity, 'rule', 'retry');
    assert.equal((await port.submitPrompt({ expected: retry, prompt: 'Read marker.txt', submissionId: 'retry',
      signal: new AbortController().signal, writeFence: (_phase, write) => {
        manager.automation.verifyNativeAction(retry.identity, 'rule', 'retry'); port.assertCurrent(retry); write();
      } })).kind, 'delivered');
  } finally { await manager.shutdownAll(); }
});

test('late native SessionStart preserves the host submit until real native confirmation and approval', async () => {
  for (const mode of ['fresh', 'restored', 'reset']) {
    const { manager, port } = await setup(false);
    try {
      assert.ok(port); const scope = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl' as const };
      manager.automation.authority = () => ({ canSuperviseNativeApproval: () => true,
        recordRuntimeObservation: () => {}, recordInputOwnership: () => {}, pauseWake: () => {},
      } as import('@/lib/automation/runtime-port').AutomationAuthority);
      if (mode !== 'fresh') manager.activateProviderSessionIdentity('terminal', 'owner', 'native');
      const ready = await port.observe(scope); assert.equal(ready.kind, 'ready'); if (ready.kind !== 'ready') return;
      manager.automation.claimNativeAction(ready.identity, 'rule', 'bootstrap');
      assert.equal((await port.submitPrompt({ expected: ready, prompt: 'Read marker.txt', submissionId: 'bootstrap',
        signal: new AbortController().signal, writeFence: (_phase, write) => {
          manager.automation.verifyNativeAction(ready.identity, 'rule', 'bootstrap'); port.assertCurrent(ready); write();
        } })).kind, 'delivered');
      manager.automation.writer('owner', 'worker', false);
      manager.activateProviderSessionIdentity('terminal', 'owner', 'native');
      if (mode === 'reset') manager.activateProviderSessionIdentity('terminal', 'owner', 'reset-native');
      const at = Date.now() + 1000;
      manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
        status: 'idle', hookEvent: 'SessionStart', stateAt: at }, 'owner');
      assert.equal(manager.automation.readNativeState('owner', 'worker')?.state, mode === 'reset' ? 'unknown' : 'running');
      assert.equal(manager.automation.readTurnEvidence(scope).kind, mode === 'reset' ? 'idle' : 'unavailable',
        'SessionStart is not accepted-turn evidence; conversation reset invalidates the prior host submit');
      manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
        status: 'running', hookEvent: 'UserPromptSubmit', stateAt: at + 1 }, 'owner');
      const association = { observerSubmissionId: 'submit', sourceIdentityHash: 'a'.repeat(64), fileGeneration: 'file',
        startByte: 0, nativeId: 'turn', dedupKey: 'submit' };
      const payload = { hook_event_name: 'UserPromptSubmit', session_id: mode === 'reset' ? 'reset-native' : 'native',
        turn_id: 'turn', tessera_autorun: association };
      const event = buildAutorunHookEvidence({ ...scope, provider: 'codex',
        observation: manager.automation.observe('owner', 'worker')!, payload });
      assert.ok(event);
      if (mode === 'reset') { assert.equal(manager.automation.recordHookEvidence(event).kind, 'rejected'); continue; }
      assert.equal(manager.automation.recordHookEvidence({ ...event, evidence: { ...event.evidence,
        terminalGeneration: event.evidence.terminalGeneration + 1 } }).kind, 'rejected');
      assert.equal(manager.automation.recordHookEvidence({ ...event, evidence: { ...event.evidence,
        providerConversationId: 'foreign' } }).kind, 'rejected');
      assert.equal(manager.automation.recordHookEvidence(event).kind, 'accepted');
      assert.equal(manager.automation.readTurnEvidence(scope).kind, 'running');
      manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
        status: 'idle', hookEvent: 'SessionStart', stateAt: at }, 'owner'); // Older than real submit.
      assert.equal(manager.automation.readNativeState('owner', 'worker')?.state, 'running');
      manager.recordSessionState({ type: 'session_state', sessionId: 'worker', terminalId: 'terminal',
        status: 'running', hookEvent: 'PreToolUse', stateAt: at + 2 }, 'owner');
      const offer = manager.openNativeApproval('terminal', 'owner', { ...payload, hook_event_name: 'PermissionRequest',
        tool_name: 'exec_command', tool_input: { command: 'cat marker.txt' }, cwd: workspace,
        tessera_native_approval: { invocationId: 'late-approval', generation: ready.identity.generation, providerVersion: '0.159.2' } });
      assert.ok(offer); const approval = await port.observe(scope); assert.equal(approval.kind, 'approval');
      if (approval.kind === 'approval') port.deferApproval!({ scope, expected: approval.request });
      assert.equal(await offer, null);
    } finally { await manager.shutdownAll(); }
  }
});
