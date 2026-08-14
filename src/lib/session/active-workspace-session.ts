import {
  getSpecialSessionSourceSessionId,
  isSpecialSession,
} from '@/lib/constants/special-sessions';
import { isOptimisticSessionId } from '@/lib/session/session-id';

export function getWorkspaceSourceSessionId(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  return getSpecialSessionSourceSessionId(sessionId)
    ?? (isSpecialSession(sessionId) ? null : sessionId);
}

export function resolveActiveWorkspaceSessionId({
  activePanelSessionId,
  activeSessionId,
}: {
  activePanelSessionId: string | null | undefined;
  activeSessionId: string | null | undefined;
}): string | null {
  return getWorkspaceSourceSessionId(activePanelSessionId)
    ?? getWorkspaceSourceSessionId(activeSessionId);
}

/**
 * Session-backed file tabs intentionally expose their source Session to Git,
 * unread, and selection logic. They are still their own tab surface, so the
 * Session→panel bridge must not use that source identity to jump back to the
 * chat tab that owns the Session.
 */
export function shouldBridgeActiveSessionToPanel({
  activePanelSessionId,
  activePanelWorkspaceSessionId,
  renderedActiveSessionId,
  currentActiveSessionId,
  projectsLoaded,
}: {
  activePanelSessionId: string | null | undefined;
  activePanelWorkspaceSessionId: string | null | undefined;
  renderedActiveSessionId: string | null | undefined;
  currentActiveSessionId: string | null | undefined;
  projectsLoaded: boolean;
}): boolean {
  // The panel→Session effect runs before the reverse bridge. If it corrected a
  // stale Session selection during this same commit, the reverse effect still
  // carries the old rendered value and must not undo the panel navigation.
  if (renderedActiveSessionId !== currentActiveSessionId) return false;
  if (activePanelSessionId && isSpecialSession(activePanelSessionId)) return false;
  return !projectsLoaded || activePanelWorkspaceSessionId !== null;
}

export function resolveCanonicalGitTargetSessionId({
  activeSessionId,
  peekWorktreeId,
}: {
  activeSessionId: string | null | undefined;
  peekWorktreeId: string | null | undefined;
}): string | null {
  if (peekWorktreeId || isOptimisticSessionId(activeSessionId)) return null;
  return activeSessionId ?? null;
}

/**
 * Resolve the session whose conversation is actually visible.
 *
 * Full-board Kanban Peek deliberately keeps the tab workspace mounted but
 * hidden. In that layout, the hidden tab's active session must not suppress
 * unread notifications or make a closed Peek card look active.
 */
export function resolveVisibleWorkspaceSessionId({
  activeSessionId,
  isKanbanPeekLayout,
  peekSessionId,
}: {
  activeSessionId: string | null | undefined;
  isKanbanPeekLayout: boolean;
  peekSessionId: string | null | undefined;
}): string | null {
  return getWorkspaceSourceSessionId(
    isKanbanPeekLayout ? peekSessionId : activeSessionId,
  );
}
