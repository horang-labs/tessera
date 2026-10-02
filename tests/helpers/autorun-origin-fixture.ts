import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TerminalManager } from '../../src/lib/terminal/terminal-manager';
import { createAutomationRuntime } from '../../src/lib/automation/runtime-adapter';
import { AUTORUN_HOOK_OBSERVER } from '../../src/lib/terminal/autorun-observer';
import { buildAutorunHookEvidence } from '../../src/lib/cli/providers/autorun-hook-evidence';
import { recordNativeSubmission } from '../../src/lib/automation/autorun-submission-producer';
import { readHumanSubmissions } from '../../src/lib/automation/autorun-human-evidence';
import { readAutorunEvidence, evidenceHash } from '../../src/lib/automation/autorun-context';
import { runFixture } from '../fixtures/automation';
import type { AutomationAuthority, Boundary } from '../../src/lib/automation/runtime-port';

export async function originFixture(provider: 'codex' | 'claude-code' = 'codex') {
  const previous = process.env.TESSERA_DATA_DIR;
  await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'autorun-origin-'));
  process.env.TESSERA_DATA_DIR = dir;
  const file = path.join(dir, 'native.jsonl'), writes: string[] = [];
  const append = (v: unknown) => fs.appendFile(file, JSON.stringify(v) + '\n');
  if (provider === 'codex') await append({ type: 'session_meta', payload: { id: 'conversation', originator: 'codex_cli_rs', source: 'cli', cwd: dir } });
  else await fs.writeFile(file, '');
  const manager = new TerminalManager(() => {}, async () => ({ spawn: () => ({ write: (s: string) => writes.push(s), resize() {}, kill() {}, onData() {}, onExit() {} }) }), undefined, { semanticPromptSubmitDelayMs: 5 });
  const selection = { provider, model: null, reasoningEffort: null, serviceTier: null, settings: { permissionPolicy: 'inherit-cli' as const, allowPreparationFailure: false as const } };
  const authority = { loadRun: () => ({ run: { ...runFixture(), id: 'run', automationId: 'rule', sessionId: 'session', effectiveSelection: selection, agentEnvironment: 'wsl' as const }, target: { kind: 'wake-session' as const, sessionId: 'session' }, prompt: 'Identical instructions', ownerUserId: 'owner' }),
    recordBoundary() {}, recordRuntimeObservation() {}, recordInputOwnership() {}, pauseWake() {}, recordOutcome() {},
    beginAttempt: (runId, leaseEpoch) => ({ runId, leaseEpoch, token: 'permit' }), withWriteFence: (_p, _phase, write) => write(),
  } as AutomationAuthority;
  const runtime = createAutomationRuntime({ manager, authority: () => authority, readSelection: async () => selection });
  await manager.create({ userId: 'owner', sessionId: 'session', terminalId: 'terminal', connectionId: 'panel', surfaceId: 'normal', providerId: provider, agentEnvironment: 'wsl', resolvedShell: { command: 'fixture', args: [], cwd: dir } });
  manager.activateProviderSessionIdentity('terminal', 'owner', 'conversation');
  let at = Date.now(), latest: ReturnType<typeof buildAutorunHookEvidence> = null;
  async function native(id: string, text: string, record = true) {
    if (provider === 'codex') await append({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
    const payload = JSON.parse(execFileSync(process.execPath, ['-e', AUTORUN_HOOK_OBSERVER], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'conversation', transcript_path: file, prompt: text, ...(provider === 'codex' ? { turn_id: id } : { prompt_id: id }) }), encoding: 'utf8' }));
    await append(provider === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } } : { type: 'user', sessionId: 'conversation', promptId: id, uuid: `record-${id}`, message: { role: 'user', content: text } });
    const receive = async () => {
      manager.recordSessionState({ type: 'session_state', sessionId: 'session', terminalId: 'terminal', hookEvent: 'UserPromptSubmit', status: 'running', stateAt: ++at }, 'owner');
      const event = buildAutorunHookEvidence({ userId: 'owner', sessionId: 'session', agentEnvironment: 'wsl', provider, observation: manager.automation.observe('owner', 'session')!, payload });
      if (!event || event.kind !== 'submission') throw Error('fixture submit');
      latest = event;
      await recordNativeSubmission({ event, prompt: text, canonicalPath: file, humanOrigin: manager.automation.ownership('owner', 'session').mode === 'human' });
      return event;
    };
    if (record) await receive();
    return receive;
  }
  function complete() { manager.recordSessionState({ type: 'session_state', sessionId: 'session', terminalId: 'terminal', hookEvent: 'Stop', status: 'completed', stateAt: ++at }, 'owner', 'successful-lead-stop'); }
  async function wake() {
    let boundary: Boundary | null = null;
    await runtime.arm({ userId: 'owner', sessionId: 'session', automationId: 'rule', selection }, evidence => { if (evidence.kind === 'completed') boundary = evidence.boundary; });
    const pending = runtime.dispatch({ runId: 'run', leaseEpoch: 1, expectedRevision: 1, expectedBoundary: boundary });
    await new Promise(r => setTimeout(r, 2));
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
  return { dir, file, manager, runtime, writes, native, complete, wake, evidence,
    close: async () => { await manager.shutdownAll(); if (previous === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous; await fs.rm(dir, { recursive: true, force: true }); } };
}
