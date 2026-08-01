import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import type { UnifiedSession } from '@/types/chat';

export const LAST_ACTIVE_PROJECT_DIR_KEY = 'ccw:lastActiveProjectDir';

type ProjectSessionIndex = {
  encodedDir: string;
  sessions: readonly Pick<UnifiedSession, 'id'>[];
};

export function findSessionProjectDir(
  projects: readonly ProjectSessionIndex[],
  sessionId: string | null | undefined,
): string | null {
  const selectionSessionId = getSessionSelectionId(sessionId);
  if (!selectionSessionId) return null;

  return projects.find((project) =>
    project.sessions.some((session) => session.id === selectionSessionId)
  )?.encodedDir ?? null;
}

export function resolveLastActiveProjectDir(
  projects: readonly Pick<ProjectSessionIndex, 'encodedDir'>[],
  lastActiveProjectDir: string | null | undefined,
): string | null {
  if (!lastActiveProjectDir) return null;
  return projects.some((project) => project.encodedDir === lastActiveProjectDir)
    ? lastActiveProjectDir
    : null;
}
