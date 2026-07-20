import type { UnifiedSession } from '@/types/chat';

export type SessionTabOpenMode = 'preview' | 'pinned';

/**
 * GUI sessions keep their existing read-only preview behavior. A live PTY
 * runtime opens pinned because replacing that view must never terminate work
 * the user already chose to retain.
 */
export function resolveSessionTabOpenMode({
  kind,
  isRunning,
}: Pick<UnifiedSession, 'kind' | 'isRunning'>): SessionTabOpenMode {
  return kind === 'terminal' && isRunning ? 'pinned' : 'preview';
}

/** A release may terminate only the runtime created with the same preview token. */
export function shouldReleasePreviewRuntime({
  runtimeOwnerToken,
  previewOwnerToken,
}: {
  runtimeOwnerToken?: string;
  previewOwnerToken: string;
}): boolean {
  return runtimeOwnerToken !== undefined && runtimeOwnerToken === previewOwnerToken;
}
