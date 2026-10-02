import { autorunHookEvidenceSchema, type AutorunHookEvidence } from '@/lib/automation/autorun-contracts';
import { evidenceHash } from '@/lib/automation/autorun-context';
import type { RuntimeObservation } from '@/lib/automation/runtime-port';

/** Authenticated owner and observed terminal identity come from the receiver, never the payload. */
export function buildAutorunHookEvidence(args: {
  userId: string; sessionId: string; agentEnvironment: 'native' | 'wsl'; provider: 'claude-code' | 'codex';
  observation: RuntimeObservation; payload: Record<string, unknown>;
}): AutorunHookEvidence | null {
  const p = args.payload, observed = p.tessera_autorun as Record<string, unknown> | undefined;
  if (!observed || !['UserPromptSubmit', 'Stop'].includes(String(p.hook_event_name))) return null;
  const id = args.provider === 'codex' ? p.turn_id : p.prompt_id;
  if (typeof id !== 'string' || id !== observed.nativeId || args.observation.userId !== args.userId || args.observation.sessionId !== args.sessionId) return null;
  const completion = p.hook_event_name === 'Stop';
  const evidence = { provider: args.provider, providerConversationId: p.session_id, observerSubmissionId: observed.observerSubmissionId,
    serverInstanceId: args.observation.serverInstanceId, terminalGeneration: args.observation.generation,
    sourceIdentityHash: observed.sourceIdentityHash, fileGeneration: observed.fileGeneration, startByte: observed.startByte, dedupKey: observed.dedupKey,
    ...(args.provider === 'codex' ? { nativeTurnId: id } : { nativePromptId: id }),
    ...(completion ? { completionHookId: observed.completionHookId, ...(args.provider === 'claude-code' ?
      { stopTextHash: typeof p.last_assistant_message === 'string' && p.last_assistant_message ? evidenceHash(p.last_assistant_message) : '' } : {}) } : {}),
  };
  const result = autorunHookEvidenceSchema.safeParse({ kind: completion ? 'completion' : 'submission', userId: args.userId,
    sessionId: args.sessionId, terminalId: args.observation.terminalId, agentEnvironment: args.agentEnvironment, observedAt: Date.now(), evidence });
  return result.success ? result.data : null;
}
