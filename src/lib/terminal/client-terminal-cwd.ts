import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { useSessionStore } from '@/stores/session-store';

export function getInitialTerminalCwd(
  sessionId?: string | null,
  explicitCwd?: string | null,
): string | null {
  const selectionSessionId = getSessionSelectionId(sessionId ?? null);
  if (selectionSessionId) {
    return useSessionStore.getState().getSession(selectionSessionId)?.workDir ?? null;
  }

  return explicitCwd?.trim() || null;
}
