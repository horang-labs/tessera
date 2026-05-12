import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';

export function getInitialTerminalCwd(sessionId?: string | null): string | null {
  const sessionState = useSessionStore.getState();
  const selectionSessionId = getSessionSelectionId(sessionId ?? sessionState.activeSessionId);
  if (selectionSessionId) {
    const activeSession = sessionState.getSession(selectionSessionId);
    if (activeSession?.workDir) {
      return activeSession.workDir;
    }
  }

  const selectedProjectDir = useBoardStore.getState().selectedProjectDir;
  if (selectedProjectDir && selectedProjectDir !== ALL_PROJECTS_SENTINEL) {
    const selectedProject = sessionState.projects.find(
      (project) => project.encodedDir === selectedProjectDir,
    );
    return selectedProject?.decodedPath ?? null;
  }

  return sessionState.projects[0]?.decodedPath ?? null;
}
