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
export type RunSpec = {run:AutomationRun; target:Target; prompt:string; ownerUserId:string};
export interface AutomationRuntime { // implemented by B; A supplies persistence callbacks
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
export interface AutomationAuthority { // implemented by A; called by B
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
