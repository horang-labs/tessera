import { randomUUID } from 'node:crypto';
import type { AutomationActivation, NativeApprovalRequest, ReadyPromptEvidence, SupervisorApprovalDecision, SupervisorApprovalPacket } from './activation-contracts';
import type { SupervisorCapability, SupervisorSelection } from './autorun-contracts';

export type NativeAutomationAction =
  | { kind: 'bootstrap'; activationId: string; expected: ReadyPromptEvidence }
  | { kind: 'approval'; activationId: string; expected: NativeApprovalRequest; optionId: string; decisionId: string };
export type StoredApprovalDecision = {
  id: string; request: NativeApprovalRequest; packet: SupervisorApprovalPacket; selection: SupervisorSelection;
  capability: SupervisorCapability; invocationId: string; startedAt: number; finishedAt: number | null;
  quiescent: boolean | null; phase: 'analysing' | 'decided' | 'cancelled';
  decision: SupervisorApprovalDecision | null; runId: string | null;
};
export type StoredActivation = {
  projection: AutomationActivation; firstAction: 'pending' | 'reserved' | 'delivered' | 'unknown' | 'superseded';
  approvals: StoredApprovalDecision[];
};
export function newActivation(): StoredActivation {
  return { projection: { activationId: randomUUID(), phase: 'waiting', reason: 'runtime-unverified', approval: null },
    firstAction: 'pending', approvals: [] };
}
