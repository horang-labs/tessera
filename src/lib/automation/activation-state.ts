import { randomUUID } from 'node:crypto';
import type { AutomationActivation, NativeApprovalRequest, ReadyPromptEvidence, SupervisorApprovalDecision, SupervisorApprovalPacket } from './activation-contracts';
import type { SupervisorCapability, SupervisorSelection } from './autorun-contracts';

export type StartupEvidence = {
  userId: string; sessionId: string; agentEnvironment: 'native'|'wsl'; serverInstanceId: string;
  ownershipEpoch: string; generation: number | null; mode: 'fresh'|'resume';
};
export type NativeAutomationAction = (
  | { kind: 'startup'; activationId: string; expected: StartupEvidence }
  | { kind: 'bootstrap'; activationId: string; expected: ReadyPromptEvidence }
  | { kind: 'approval'; activationId: string; expected: NativeApprovalRequest; optionId: string; decisionId: string }) & { inputEpoch: string };
export type StoredApprovalDecision = {
  id: string; request: NativeApprovalRequest; packet: SupervisorApprovalPacket; selection: SupervisorSelection;
  capability: SupervisorCapability; invocationId: string; startedAt: number; finishedAt: number | null;
  quiescent: boolean | null; phase: 'analysing' | 'decided' | 'cancelled';
  decision: SupervisorApprovalDecision | null; runId: string | null;
  settlementObservation?: Extract<import('./autorun-contracts').SupervisorSettlementObservation,{kind:'quiescent'}>;
};
export type StoredActivation = {
  projection: AutomationActivation; firstAction: 'pending' | 'reserved' | 'delivered' | 'unknown' | 'superseded';
  approvals: StoredApprovalDecision[];
};
export function newActivation(approvals: StoredApprovalDecision[] = []): StoredActivation {
  return { projection: { activationId: randomUUID(), phase: 'waiting', reason: 'runtime-unverified', approval: null },
    firstAction: 'pending', approvals: structuredClone(approvals) };
}
