import type { ProjectGroup, UnifiedSession } from '@/types/chat';

/** Resolve the best canonical payload available in direct and retained storage. */
export function resolveStoredCanonicalSession(
  projects: readonly ProjectGroup[],
  retainedSessions: Readonly<Record<string, UnifiedSession>>,
  sessionId: string,
): UnifiedSession | undefined {
  let fallback: UnifiedSession | undefined;
  for (const project of projects) {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) continue;
    if (project.encodedDir === session.originProjectId) return session;
    fallback ??= session;
  }
  return fallback ?? retainedSessions[sessionId];
}

/** Preserve an exact loaded appearance, otherwise project the stored canonical payload. */
export function resolveStoredSessionAppearance(
  projects: readonly ProjectGroup[],
  retainedSessions: Readonly<Record<string, UnifiedSession>>,
  sessionId: string,
  projectViewId?: string | null,
): UnifiedSession | undefined {
  if (projectViewId) {
    const exact = projects
      .find((project) => project.encodedDir === projectViewId)
      ?.sessions.find((session) => session.id === sessionId);
    if (exact) return exact;
  }
  const canonical = resolveStoredCanonicalSession(projects, retainedSessions, sessionId);
  return canonical && projectViewId
    ? { ...canonical, projectDir: projectViewId, collectionId: undefined }
    : canonical;
}
