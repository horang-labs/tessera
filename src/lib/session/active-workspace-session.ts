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
