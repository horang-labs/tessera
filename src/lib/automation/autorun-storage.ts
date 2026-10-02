import type { Automation, ControlResult } from './contracts';
import { isDeepStrictEqual } from 'node:util';
import type { AnalysisContextSnapshot, AutomationV2, AutorunAutomation, AutorunDecisionDetail, SupervisorSettlementObservation } from './autorun-contracts';
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
  settlementObservations?: Record<string,Extract<SupervisorSettlementObservation,{kind:'quiescent'}>>;
};

/** Read accounting is not source identity: R1's contentHash attests captured bytes to this cutoff. */
export function sameCapturedPrefix(a: AnalysisIdentity['source'], b: AnalysisIdentity['source']): boolean {
  const ranges=(source:AnalysisIdentity['source'])=>source.scannedRanges
    .map(range=>({startByte:range.startByte,endByte:Math.min(range.endByte,source.endByte)}))
    .filter(range=>range.startByte<range.endByte);
  return a.identityHash===b.identityHash && a.fileGeneration===b.fileGeneration && a.startByte===b.startByte &&
    a.endByte===b.endByte && a.latestTurnStartByte===b.latestTurnStartByte && JSON.stringify(ranges(a))===JSON.stringify(ranges(b));
}

export function sameCapturedContext(a:AnalysisContextSnapshot,b:AnalysisContextSnapshot):boolean {
  return sameCapturedPrefix(a.source,b.source)&&a.contentHash===b.contentHash&&a.provider===b.provider&&
    a.cliVersion===b.cliVersion&&a.parserVersion===b.parserVersion&&isDeepStrictEqual(a.cutoff,b.cutoff);
}
