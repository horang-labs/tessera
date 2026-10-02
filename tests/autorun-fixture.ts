import { fixture } from './automation-fixture';
import { AutomationEngine } from '../src/lib/automation/engine';
import { TerminalManager } from '../src/lib/terminal/terminal-manager';
import { createAutomationRuntime } from '../src/lib/automation/runtime-adapter';
import { autorunInput, contextSnapshot, supervisorFinalFixture, autorunNow } from './fixtures/autorun-contracts';
import type { AutorunProviderPort } from '../src/lib/cli/providers/session-types';
import type { AnalysisContextSnapshot } from '../src/lib/automation/autorun-contracts';

export async function autorunFixture(ownerUserId = 'owner-1') {
  const f = fixture(); f.setNow(autorunNow);
  const bytes: string[] = [];
  const manager = new TerminalManager(() => {}, async () => ({ spawn: () => ({
    write: (data: string) => bytes.push(data), resize() {}, kill() {}, onData() {}, onExit() {},
  }) }), undefined, { semanticPromptSubmitDelayMs: 5 });
  const worker = contextSnapshot().workerSelection;
  let calls = 0;
  const provider: AutorunProviderPort = {
    version: 1,
    readAutorunEvidence: async args => ({ kind: 'ok', goal: { kind: 'verified', objective: {
      kind: 'verified-human', text: 'Fix login.', revision: args.goalRevision,
      sources: [{ messageId: 'message-1', recordId: 'record-1', textHash: 'd'.repeat(64), excerpt: 'Fix login.', origin: 'tessera-human-correlated' }],
    } }, newHumanInstructions: [], turnEvidence: args.turnEvidence }),
    readAnalysisContext: async args => {
      const snapshot: AnalysisContextSnapshot = { ...contextSnapshot(), boundary: args.expectedBoundary, inputEpoch: args.inputEpoch,
        providerConversationId:args.providerConversationId,userId: args.userId, agentEnvironment: args.agentEnvironment, workerSelection: args.workerSelection, correlation: args.correlation };
      return { kind: 'ok', snapshot };
    },
    checkSupervisorCapability: async args => ({ kind: 'available', capability: { version: 1, selection: args.selection,
      cliVersion: args.selection.provider === 'codex' ? '0.159.2' : '2.1.284',
      proofId: args.selection.provider === 'codex' ? 'codex-0.159.2-packet-catalog-v1' : 'claude-2.1.284-safe-restricted-v1',
      isolationPolicyVersion: 'autorun-530-v1', available: true, checkedAt: autorunNow } }),
    generateSupervisorDecision: async args => { calls++; return { ...supervisorFinalFixture(), invocationId: args.invocationId } as Awaited<ReturnType<AutorunProviderPort['generateSupervisorDecision']>>; },
  };
  f.service.deps.inspect = async () => ({ selection: worker, canonicalWorktreeId: null, assertCurrent() {} });
  f.service.deps.provider = () => provider;
  const engine = new AutomationEngine(f.service, 'autorun-instance');
  const runtime = createAutomationRuntime({ manager, authority: () => engine, readSelection: async () => worker, autorunProvider: () => provider });
  f.service.deps.runtime = () => runtime;
  f.service.deps.settleAnalysisHold=(owner,session,id)=>manager.automation.settleAnalysisHold(owner,session,id);
  f.service.deps.retainAnalysisHold=(owner,session,id)=>manager.automation.holdAnalysis(owner,session,id);
  f.service.deps.owner = async () => ({ userId: ownerUserId, agentEnvironment: 'wsl' });
  await manager.create({ userId: ownerUserId, sessionId: 'session-1', terminalId: 'terminal-1', connectionId: 'panel', surfaceId: 'normal',
    providerId: 'codex', agentEnvironment: 'wsl', resolvedShell: { command: 'fixture', args: [], cwd: process.cwd() } });
  manager.activateProviderSessionIdentity('terminal-1', ownerUserId, 'conversation-1');
  let time = autorunNow;
  function submit() {
    time+=100;
    manager.automation.hook(ownerUserId, 'session-1', 'UserPromptSubmit', 'running', ++time, false);
    const evidence = { ...contextSnapshot().correlation, serverInstanceId: manager.automation.serverInstanceId, terminalGeneration: 1,
      dedupKey: `submit-${time}`, observerSubmissionId: `submit-${time}` };
    const { completionHookId: _hook, ...submission } = evidence; void _hook;
    runtime.autorun!.recordHookEvidence({ kind: 'submission', userId: ownerUserId, agentEnvironment: 'wsl', sessionId: 'session-1', terminalId: 'terminal-1', observedAt: time, evidence: submission });
    return evidence;
  }
  function complete(evidence: ReturnType<typeof submit>) {
    runtime.autorun!.recordHookEvidence({ kind: 'completion', userId: ownerUserId, agentEnvironment: 'wsl', sessionId: 'session-1', terminalId: 'terminal-1', observedAt: ++time,
      evidence: { ...evidence, dedupKey: `stop-${time}`, completionHookId: `stop-${time}` } });
    manager.automation.hook(ownerUserId, 'session-1', 'Stop', 'completed', ++time, false, 'successful-lead-stop');
  }
  const evidence = submit(); complete(evidence);
  await engine.tick();
  return { ...f, engine, runtime, manager, provider, bytes, input: () => ({ ...autorunInput(), enabled: true }), calls: () => calls, submit, complete,
    close: async () => { await engine.stop(); await manager.shutdownAll(); f.close(); } };
}
