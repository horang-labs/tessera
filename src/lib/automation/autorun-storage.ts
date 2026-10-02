import type { Automation, ControlResult } from './contracts';
import type { AutomationV2, AutorunAutomation, AutorunDecisionDetail } from './autorun-contracts';
import type { AnalysisIdentity } from './runtime-port';

/** Legacy journal records remain byte-for-byte unchanged until explicitly edited. */
export type DurableAutomation = Automation | AutomationV2;
export type DurableControlResult = Omit<ControlResult, 'automation'> & { automation: DurableAutomation };
export type DurableControlResponse = { status: 200 | 202; body: DurableControlResult };
export const isAutorun = (a: DurableAutomation): a is AutorunAutomation => 'mode' in a && a.mode === 'autorun';
export type StoredDecision = {
  detail: AutorunDecisionDetail; identity: AnalysisIdentity; active: boolean;
  packetSelection: AutorunAutomation['autorun']['supervisor']; leaseEpoch: number;
  evidenceHash: string; proposalHash: string | null; noProgressStreak: number; unchangedStreak: number;
};
