import type { AutorunHookEvidence } from './autorun-contracts';
import { evidenceHash } from './autorun-context';
import { submissionOrigin } from './autorun-origin';
import { recordHumanSubmission } from './autorun-human-evidence';

/** Called only after the authenticated receiver has checked the live runtime binding. */
export async function recordNativeSubmission(args: {
  event: Extract<AutorunHookEvidence, { kind: 'submission' }>;
  prompt: string; canonicalPath: string; humanOrigin: boolean;
}) {
  const { event, prompt } = args, e = event.evidence;
  await recordHumanSubmission(event.userId, event.sessionId, {
    nativeId: e.provider === 'codex' ? e.nativeTurnId : e.nativePromptId,
    sourceIdentityHash: e.sourceIdentityHash, fileGeneration: e.fileGeneration,
    text: prompt, textHash: evidenceHash(prompt), origin: await submissionOrigin(args),
    provenance: { version: 1, agentEnvironment: event.agentEnvironment },
    observerSubmissionId: e.observerSubmissionId,
  });
}
