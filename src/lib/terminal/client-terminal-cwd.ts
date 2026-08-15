import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';

export function getInitialTerminalCwd(
  sessionId?: string | null,
  explicitCwd?: string | null,
): string | null {
  const selectionSessionId = getSessionSelectionId(sessionId ?? null);
  if (selectionSessionId) {
    return projectViewWorkspaceState.resolveSession(selectionSessionId)?.workDir ?? null;
  }

  return explicitCwd?.trim() || null;
}
