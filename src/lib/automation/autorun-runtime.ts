import { isDeepStrictEqual } from 'node:util';
import type { TerminalManager } from '../terminal/terminal-manager';
import type { AutorunProviderPort } from '../cli/providers/session-types';
import { AUTORUN_BOUNDS, analysisContextSnapshotSchema, type AnalysisContextResult, type AnalysisContextSnapshot } from './autorun-contracts';
import { sameCapturedPrefix } from './autorun-storage';
import { sameSessionSelection, type SessionSelectionSnapshot } from './contracts';
import type { AutorunRuntimePort } from './runtime-port';

export function createAutorunRuntime(options: {
  manager: TerminalManager;
  provider?: (provider: string) => AutorunProviderPort | null;
  readSelection(userId: string, sessionId: string): Promise<SessionSelectionSnapshot>;
  verifySelection?: (userId: string, sessionId: string, selection: SessionSelectionSnapshot) => void;
}): AutorunRuntimePort {
  const gate = options.manager.automation;
  const snapshots = new Map<string, AnalysisContextSnapshot>();
  const pendingReads = new Map<string,Promise<AnalysisContextResult>>();
  const key = (owner: string, session: string) => JSON.stringify([owner, session]);
  return {
    version: 1,
    recordHookEvidence: event => gate.recordHookEvidence(event),
    readTurnEvidence: args => gate.readTurnEvidence(args),
    async captureAnalysisContext(args) {
      const captureKey=key(args.userId,args.sessionId);
      snapshots.delete(captureKey);
      if(pendingReads.has(captureKey)||pendingReads.size>=2)return {kind:'unavailable',code:'CONTEXT_UNAVAILABLE',reason:'flush-pending'};
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),AUTORUN_BOUNDS.flushWaitMs);timer.unref?.();
      const signal=AbortSignal.any([args.signal,controller.signal]);
      const capture=async():Promise<AnalysisContextResult>=>{
        const inputEpoch = gate.ownership(args.userId, args.sessionId).epoch;
        try {
          options.manager.assertAutomationArmable(args.userId, args.sessionId);
          const turn = gate.assertAnalysis({ ...args, inputEpoch });
          const workerSelection = await options.readSelection(args.userId, args.sessionId);
          gate.assertAnalysis({ ...args, inputEpoch });
          const port = options.provider?.(workerSelection.provider);
          if (!port) return { kind: 'unavailable', code: 'SUPERVISOR_UNSUPPORTED', reason: 'unsupported-version' };
          const selection = await options.readSelection(args.userId, args.sessionId);
          gate.assertAnalysis({ ...args, inputEpoch });
          if (!sameSessionSelection(workerSelection, selection)) throw new Error('stale');
          if(signal.aborted)throw new Error('aborted');
          const result = await port.readAnalysisContext({ ...args, signal, inputEpoch, workerSelection,
            providerConversationId: turn.correlation.providerConversationId, correlation: turn.correlation });
          options.manager.assertAutomationArmable(args.userId, args.sessionId);
          const current = gate.assertAnalysis({ ...args, inputEpoch });
          options.verifySelection?.(args.userId,args.sessionId,workerSelection);
          if (signal.aborted || !sameSessionSelection(workerSelection, selection) ||
            !isDeepStrictEqual(current.correlation, turn.correlation)) throw new Error('stale');
          if (result.kind !== 'ok') return result;
          const parsed = analysisContextSnapshotSchema.safeParse(result.snapshot);
          if (!parsed.success || result.snapshot.inputEpoch !== inputEpoch || result.snapshot.userId !== args.userId ||
            result.snapshot.agentEnvironment !== args.agentEnvironment ||
            !isDeepStrictEqual(result.snapshot.boundary, args.expectedBoundary) ||
            !isDeepStrictEqual(result.snapshot.correlation, turn.correlation) ||
            !sameSessionSelection(result.snapshot.workerSelection, workerSelection)) throw new Error('invalid context');
          snapshots.set(key(args.userId, args.sessionId), parsed.data);
          return { kind: 'ok', snapshot: parsed.data };
        } catch { return { kind: 'unavailable', code: 'ANALYSIS_STALE', reason: 'stale' }; }
      };
      let onAbort!:()=>void;
      const aborted=new Promise<AnalysisContextResult>(resolve=>{
        onAbort=()=>resolve({kind:'unavailable',code:'CONTEXT_UNAVAILABLE',reason:'flush-pending'});
        if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
      });
      const pending=capture();pendingReads.set(captureKey,pending);
      const settled=()=>{if(pendingReads.get(captureKey)===pending)pendingReads.delete(captureKey);};
      void pending.then(settled,settled);
      try{return await Promise.race([pending,aborted]);}
      finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
    },
    commitAnalysisDecision(identity, commit) {
      const captureKey=key(identity.userId, identity.expectedBoundary.sessionId);
      const snapshot = snapshots.get(captureKey);
      snapshots.delete(captureKey);
      if (!snapshot || snapshot.contentHash !== identity.contentHash || !sameCapturedPrefix(snapshot.source, identity.source) ||
        snapshot.providerConversationId !== identity.providerConversationId || !sameSessionSelection(snapshot.workerSelection, identity.workerSelection))
        return { kind: 'rejected', code: 'ANALYSIS_STALE' };
      try {
        options.manager.assertAutomationArmable(identity.userId, identity.expectedBoundary.sessionId);
        options.verifySelection?.(identity.userId, identity.expectedBoundary.sessionId, identity.workerSelection);
      } catch { return { kind: 'rejected', code: 'ANALYSIS_STALE' }; }
      return gate.commitAnalysis({ ...identity, sessionId: identity.expectedBoundary.sessionId }, commit);
    },
  };
}
