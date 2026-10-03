import type { AutomationRun, InputOwnership, SessionSelectionSnapshot, Target } from './contracts';

export type Boundary = {
  id: string; serverInstanceId: string; terminalId: string; generation: number;
  sessionId: string; userId: string; turnSequence: number; inputRevision: number;
  completedAt: number; source: 'confirmed-lead-turn';
};
export type ArmEvidence =
  | {kind:'completed'; boundary:Boundary}
  | {kind:'submitted-running'; serverInstanceId:string; terminalId:string;
     generation:number; sessionId:string; userId:string;
     turnSequence:number; inputRevision:number};
export type DispatchResult =
  | {kind:'delivered'; sessionId:string; terminalId:string; at:number}
  | {kind:'deferred'; reason:string; retryAt:number}
  | {kind:'failed'; reason:string} // proven no external action/runtime
  | {kind:'cancelled'; reason:string} // stopped before any external action
  | {kind:'unknown'; reason:string; sessionId:string|null};
export type RuntimeObservation = {
  userId:string; sessionId:string; terminalId:string;
  serverInstanceId:string; generation:number; sequence:number; observedAt:number;
  state:AutomationRun['observedRuntime'];
  backgroundWork:'clear'|'active'|'unknown';
  exitKind:'natural'|'explicit-stop'|'shutdown'|null;
};
export type RecoveryResult =
  | {kind:'observed'|'resumed'; observation:RuntimeObservation;
     inputOwnership:InputOwnership}
  | {kind:'unavailable'|'unknown'; reason:string;
     inputOwnership:InputOwnership};
export type DispatchPermit = {runId:string; leaseEpoch:number; token:string};
export type RunSpec = {action?: import('./activation-state').NativeAutomationAction; run:AutomationRun; target:Target; prompt:string; ownerUserId:string};
export interface AutomationRuntime {
  readonly activation?: {
    observe(args: import('./activation-contracts').InteractionScope): Promise<import('./activation-contracts').NativeInteraction>;
    assertCurrent(expected: import('./activation-contracts').ReadyPromptEvidence | import('./activation-contracts').NativeApprovalRequest): void;
    setDraftVeto(args: import('./activation-contracts').InteractionScope, veto: import('./activation-contracts').AutomationDraftVeto): void;
  }; // implemented by B; A supplies persistence callbacks
  /** Optional until R2 installs the real gate; legacy delivery/input/drain remain unchanged. */
  readonly autorun?: AutorunRuntimePort;
  reconcileRun(args:{runId:string; leaseEpoch:number}): Promise<RecoveryResult>;
  ownership(userId:string, sessionId:string): InputOwnership;
  arm(args:{userId:string; sessionId:string; automationId:string; selection:SessionSelectionSnapshot},
      commit:(evidence:ArmEvidence, ownership:InputOwnership)=>void): Promise<InputOwnership>;
  drain(args:{userId:string; sessionId:string; automationId:string}): InputOwnership;
  releaseRecovery(args:{userId:string; sessionId:string; runId:string},
      commit:()=>void): InputOwnership;
  dispatch(args:{runId:string; leaseEpoch:number; expectedRevision:number;
      expectedBoundary:Boundary|null}): Promise<DispatchResult>;
}
export interface AutomationAuthority {
  canSuperviseNativeApproval?(scope: import('./activation-contracts').InteractionScope & {provider: 'codex' | 'claude-code'}): boolean; // implemented by A; called by B
  loadRun(runId:string): RunSpec;
  reserveSession(runId:string, create:(sessionId:string)=>void): string;
  beginAttempt(runId:string, leaseEpoch:number, expectedRevision:number): DispatchPermit;
  withWriteFence(permit:DispatchPermit, phase:'begin'|'complete', write:()=>void): void;
  withRecoveryFence(args:{runId:string; leaseEpoch:number; sessionId:string},
      verifyRuntimeOwnership:()=>boolean, resume:()=>void): void;
  recordBoundary(event:{userId:string; boundary:Boundary}): void;
  recordRuntimeObservation(event:RuntimeObservation): void;
  recordOutcome(runId:string, outcome:DispatchResult): void;
  recordInputOwnership(userId:string, ownership:InputOwnership): void;
  pauseWake(userId:string, sessionId:string, reason:string): void;
}

/** Immutable pre/post-read identity. All checks plus DB CAS execute within the same synchronous gate. */
export type AnalysisIdentity = {
  automationId: string; automationRevision: number; goalRevision: number; decisionId: string;
  userId: string; agentEnvironment: 'native' | 'wsl'; leaseEpoch: number; deadlineAt: number;
  expectedBoundary: Boundary; inputEpoch: string; providerConversationId: string;
  workerSelection: SessionSelectionSnapshot; supervisorSelection: import('./autorun-contracts').SupervisorSelection;
  source: import('./autorun-contracts').AnalysisContextSnapshot['source']; contentHash: string;
};
export type AnalysisDecisionCommit = { decisionId: string; automationRevision: number };
export type AnalysisCommitResult =
  | { kind: 'committed'; receipt: AnalysisDecisionCommit }
  | { kind: 'rejected'; code: 'ANALYSIS_STALE' | 'RUNTIME_ADAPTER_UNAVAILABLE' };
export interface AutorunRuntimePort {
  readonly version: 1;
  /** Authenticated R1 hook handoff; synchronously reject wrong owner/runtime/generation/provider binding.
   * Observing a hook does not manufacture a Boundary or confer input ownership.
   */
  recordHookEvidence(event: import('./autorun-contracts').AutorunHookEvidence): { kind: 'accepted' | 'rejected' };
  /** Read the current associated submit/completion under the runtime gate; R2 still checks ledger/admission.
   * R2 must recheck identity/epoch after R1's asynchronous evidence read, including before arm commit.
   */
  readTurnEvidence(args: { userId: string; agentEnvironment: 'native' | 'wsl'; sessionId: string }): import('./autorun-contracts').AutorunTurnEvidence;
  /** Recheck exact runtime/input/selection before and after the async provider read; never hold a DB transaction. */
  captureAnalysisContext(args: {
    userId: string; agentEnvironment: 'native' | 'wsl'; sessionId: string;
    expectedBoundary: Boundary; signal: AbortSignal;
  }): Promise<import('./autorun-contracts').AnalysisContextResult>;
  /** Check runtime identity and snapshotted prefix; callback performs owner/revision/lease/expiry DB CAS.
   * No await/Promise callback is permitted. Throwing rolls back persistence; no current outcome is published.
   */
  commitAnalysisDecision(expectedIdentity: AnalysisIdentity,
    commit: () => AnalysisDecisionCommit): AnalysisCommitResult;
}
export function getAutorunRuntimePort(runtime: Pick<AutomationRuntime, 'autorun'>) {
  return runtime.autorun
    ? { kind: 'available' as const, port: runtime.autorun }
    : { kind: 'unavailable' as const, code: 'RUNTIME_ADAPTER_UNAVAILABLE' as const };
}
