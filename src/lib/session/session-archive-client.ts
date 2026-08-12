import { useSessionStore } from '@/stores/session-store';

/**
 * Session-level UI entry points archive the canonical Session, even when its
 * current appearance is composed with a Worktree Task row.
 */
export function requestSessionArchive(sessionId: string, archived = true): void {
  useSessionStore.getState().toggleArchive(sessionId, archived);
}
