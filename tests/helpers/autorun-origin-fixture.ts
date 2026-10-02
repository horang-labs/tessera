import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TerminalManager } from '../../src/lib/terminal/terminal-manager';
import { createAutomationRuntime } from '../../src/lib/automation/runtime-adapter';
import { AUTORUN_HOOK_OBSERVER } from '../../src/lib/terminal/autorun-observer';
import { buildAutorunHookEvidence } from '../../src/lib/cli/providers/autorun-hook-evidence';
import { recordNativeSubmission } from '../../src/lib/automation/autorun-submission-producer';
import { readHumanSubmissions } from '../../src/lib/automation/autorun-human-evidence';
import { readAutorunEvidence, readAnalysisContext, evidenceHash } from '../../src/lib/automation/autorun-context';
import { runFixture } from '../fixtures/automation';
import type { AutomationAuthority, Boundary } from '../../src/lib/automation/runtime-port';

export async function originFixture(provider: 'codex' | 'claude-code' = 'codex', scheduled = false) {
  const previous = process.env.TESSERA_DATA_DIR;
  await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'autorun-origin-'));
  process.env.TESSERA_DATA_DIR = dir;
  const file = path.join(dir, 'native.jsonl'), writes: string[] = [], fences: string[] = [];
  let failEnter = false;
  const append = (v: unknown) => fs.appendFile(file, JSON.stringify(v) + '\n');
  if (provider === 'codex') await append({ type: 'session_meta', payload: { id: 'conversation', originator: 'codex_cli_rs', source: 'cli', thread_source: 'user', cwd: dir } });
  else await fs.writeFile(file, '');
  const manager = new TerminalManager(() => {}, async () => ({ spawn: () => ({ write: (s: string) => { writes.push(s); if (failEnter && s === '\r') { failEnter = false; throw Error('Owned PTY bridge failed'); } }, resize() {}, kill() {}, onData() {}, onExit() {} }) }), undefined, { semanticPromptSubmitDelayMs: 5 });
  const selection = { provider, model: null, reasoningEffort: null, serviceTier: scheduled && provider === 'codex' ? 'default' as const : null, settings: { permissionPolicy: 'inherit-cli' as const, allowPreparationFailure: false as const } };
  const authority = { loadRun: () => ({ run: { ...runFixture(), id: 'run', automationId: 'rule', sessionId: 'session', effectiveSelection: selection, agentEnvironment: 'wsl' as const }, target: scheduled ? { kind: 'create-session' as const, worktreeId: 'worktree', title: 'scheduled', selection } : { kind: 'wake-session' as const, sessionId: 'session' }, prompt: 'Identical instructions', ownerUserId: 'owner' }),
    recordBoundary() {}, recordRuntimeObservation() {}, recordInputOwnership() {}, pauseWake() {}, recordOutcome() {},
    reserveSession: (_id, create) => { create('session'); return 'session'; },
    beginAttempt: (runId, leaseEpoch) => ({ runId, leaseEpoch, token: 'permit' }), withWriteFence: (_p, phase, write) => { fences.push(phase); write(); },
  } as AutomationAuthority;
  const createTerminal = async (spawnFence?: (spawn: () => void) => void) => {
    await manager.create({ userId: 'owner', sessionId: 'session', terminalId: 'terminal', connectionId: 'panel', surfaceId: 'normal', providerId: provider, agentEnvironment: 'wsl', resolvedShell: { command: 'fixture', args: scheduled ? ['Identical instructions'] : [], cwd: dir }, spawnFence });
    manager.activateProviderSessionIdentity('terminal', 'owner', 'conversation');
  };
  const runtime = createAutomationRuntime({ manager, authority: () => authority, readSelection: async () => selection,
    createSession() {}, launch: async request => {
      if (request.initialPrompt !== 'Identical instructions') throw Error('Missing ordinary initial prompt');
      await createTerminal(request.spawnFence);
      return { terminalId: 'terminal', attachedToExistingRuntime: false };
    },
  });
  if (!scheduled) await createTerminal();
  let at = Date.now(), latest: ReturnType<typeof buildAutorunHookEvidence> = null;
  async function native(id: string, text: string, record = true, delayedPersistence = false) {
    const startNative = async () => {
      if (provider === 'codex') {
        await append({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
        await append({ type: 'turn_context', payload: { turn_id: id, model: 'gpt-6.1-sol', effort: 'high' } });
      }
    };
    const persistUser = () => append(provider === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } } : { type: 'user', sessionId: 'conversation', promptId: id, uuid: `record-${id}`, message: { role: 'user', content: text } });
    if (!delayedPersistence) await startNative();
    const payload = JSON.parse(execFileSync(process.execPath, ['-e', AUTORUN_HOOK_OBSERVER], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'conversation', transcript_path: file, prompt: text, ...(provider === 'codex' ? { turn_id: id } : { prompt_id: id }) }), encoding: 'utf8' }));
    if (!delayedPersistence) await persistUser();
    const receive = async () => {
      manager.recordSessionState({ type: 'session_state', sessionId: 'session', terminalId: 'terminal', hookEvent: 'UserPromptSubmit', status: 'running', stateAt: ++at }, 'owner');
      const event = buildAutorunHookEvidence({ userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', provider, observation: manager.automation.observe('owner', 'session')!, payload });
      if (!event || event.kind !== 'submission') throw Error('fixture submit');
      latest = event;
      await recordNativeSubmission({ event, prompt: text, canonicalPath: file, humanOrigin: manager.automation.ownership('owner', 'session').mode === 'human' });
      return event;
    };
    if (record) await receive();
    return delayedPersistence ? async () => { await startNative(); await persistUser(); } : receive;
  }
  function complete() { manager.recordSessionState({ type: 'session_state', sessionId: 'session', terminalId: 'terminal', hookEvent: 'Stop', status: 'completed', stateAt: ++at }, 'owner', 'successful-lead-stop'); }
  async function beginWake() {
    let boundary: Boundary | null = null;
    await runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => { if (evidence.kind === 'completed') boundary = evidence.boundary; });
    return { pending: runtime.dispatch({ runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary }) };
  }
  async function wake() {
    const previousWrites = writes.length;
    const { pending } = await beginWake();
    const deadline = Date.now() + 1000;
    while (writes.length === previousWrites && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
    runtime.drain({ userId: 'owner', sessionId: 'session', automationId: 'rule' });
    return pending;
  }
  async function evidence(previousHumanSourceIds: string[] = []) {
    if (!latest) throw Error('no native');
    const observation = manager.automation.observe('owner', 'session')!;
    return readAutorunEvidence({ userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', providerConversationId: 'conversation', workerSelection: selection, inputEpoch: manager.automation.ownership('owner', 'session').epoch,
      goalRevision: 1, previousHumanSourceIds, signal: new AbortController().signal,
      turnEvidence: { kind: 'running', submission: latest.evidence, acceptedTurn: { ...observation, turnSequence: 1, inputRevision: 1 } } }, {
      verifyBinding: async () => true, resolveSource: async () => ({ path: file, canonicalPath: file, identityHash: evidenceHash(file), fileGeneration: latest!.evidence.fileGeneration, cliVersion: 'fixture' }), readHumanSubmissions,
    });
  }
  async function context() {
    if (!latest) throw Error('no native');
    const e = latest.evidence, id = e.provider === 'codex' ? e.nativeTurnId : e.nativePromptId;
    if (provider === 'codex') {
      await append({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE' }] } });
      await append({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id, last_agent_message: 'DONE' } });
    } else await append({ type: 'assistant', sessionId: 'conversation', uuid: 'final', parentUuid: `record-${id}`, message: { content: [{ type: 'text', text: 'DONE' }] } });
    const observation = manager.automation.observe('owner', 'session')!;
    return readAnalysisContext({ userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', providerConversationId: 'conversation', workerSelection: selection,
      inputEpoch: manager.automation.ownership('owner', 'session').epoch, signal: new AbortController().signal,
      expectedBoundary: { id: 'boundary', userId: 'owner', sessionId: 'session', terminalId: observation.terminalId, serverInstanceId: observation.serverInstanceId, generation: observation.generation, source: 'confirmed-lead-turn', turnSequence: 1, inputRevision: 1, completedAt: Date.now() },
      correlation: { ...e, completionHookId: 'completion', ...(e.provider === 'claude-code' ? { stopTextHash: evidenceHash('DONE') } : {}) },
    }, { verifyBinding: async () => true, resolveSource: async () => ({ path: file, canonicalPath: file, identityHash: evidenceHash(file), fileGeneration: e.fileGeneration, cliVersion: provider === 'codex' ? '0.159.2' : '2.1.284' }) });
  }
  return { dir, file, manager, runtime, writes, fences, native, complete, beginWake, wake, evidence, context, failNextEnter: () => { failEnter = true; },
    launch: () => runtime.dispatch({ runId: 'scheduled-run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: null }),
    close: async () => { await manager.shutdownAll(); if (previous === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous; await fs.rm(dir, { recursive: true, force: true }); } };
}
