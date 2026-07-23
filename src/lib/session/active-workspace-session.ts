import {
  getSpecialSessionSourceSessionId,
  isSpecialSession,
} from '@/lib/constants/special-sessions';

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
