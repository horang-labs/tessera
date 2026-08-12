import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';

export function getSessionOriginProjectId(session: UnifiedSession): string {
  return session.originProjectId;
}

/** Remove Project View appearances that belong to another Project's origin. */
export function getTaskOriginProjectRepresentation(task: TaskEntity): TaskEntity {
  const sessions = task.sessions.filter(
    (session) => session.originProjectId === task.projectId,
  );
  return sessions.length === task.sessions.length ? task : { ...task, sessions };
}

export function originProjectContainsRunningSession(
  project: ProjectGroup,
  tasks: TaskEntity[],
): boolean {
  return project.sessions.some((session) =>
    !session.archived && resolveSessionRuntimePresentation(session).showRunning
  ) || tasks.some((task) => task.sessions.some((session) =>
    resolveSessionRuntimePresentation(session).showRunning
  ));
}

/** Count canonical running Sessions already assigned to one origin representation. */
export function countOriginProjectRunningSessions(project: ProjectGroup): number {
  return project.sessions.filter((session) =>
    !session.archived && resolveSessionRuntimePresentation(session).showRunning
  ).length;
}

/** Preserve Project strip/sidebar ordering without exposing backing Session scans to UI code. */
export function getOriginProjectOrderedSessionIds(
  representation: ReturnType<typeof buildOriginProjectRepresentation>,
): string[] {
  return representation.projects.flatMap((project) =>
    project.sessions
      .filter((session) => !session.archived)
      .slice()
      .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
      .map((session) => session.id),
  );
}

/**
 * Global aggregate surfaces deliberately use the persisted origin Project as
 * the one representative location. Alternate Project View appearances are
 * omitted instead of being deduplicated after presentation.
 */
export function buildOriginProjectRepresentation(
  projects: ProjectGroup[],
  tasksByProject: Record<string, TaskEntity[]>,
  canonicalSessions?: readonly UnifiedSession[],
) {
  const seenSessionIds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const sessionsByProject = new Map<string, UnifiedSession[]>();
  const tasksByOriginProject = new Map<string, TaskEntity[]>();

  if (canonicalSessions) {
    for (const session of canonicalSessions) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      const originProjectId = getSessionOriginProjectId(session);
      const sessions = sessionsByProject.get(originProjectId) ?? [];
      sessions.push(session.projectDir === originProjectId
        ? session
        : { ...session, projectDir: originProjectId });
      sessionsByProject.set(originProjectId, sessions);
    }
  } else {
    for (const project of projects) {
      for (const session of project.sessions) {
        if (getSessionOriginProjectId(session) !== project.encodedDir) continue;
        if (seenSessionIds.has(session.id)) continue;
        seenSessionIds.add(session.id);
        const sessions = sessionsByProject.get(project.encodedDir) ?? [];
        sessions.push(session);
        sessionsByProject.set(project.encodedDir, sessions);
      }
    }
  }

  for (const tasks of Object.values(tasksByProject)) {
    for (const task of tasks) {
      if (seenTaskIds.has(task.id)) continue;
      seenTaskIds.add(task.id);
      const originTasks = tasksByOriginProject.get(task.projectId) ?? [];
      originTasks.push(getTaskOriginProjectRepresentation(task));
      tasksByOriginProject.set(task.projectId, originTasks);
    }
  }

  const representedProjects = projects.map((project) => ({
    ...project,
    sessions: sessionsByProject.get(project.encodedDir) ?? [],
  }));
  const representedTasksByProject = Object.fromEntries(
    projects.map((project) => [
      project.encodedDir,
      canonicalSessions
        ? mergeTasksWithLiveSessions(
            tasksByOriginProject.get(project.encodedDir) ?? [],
            sessionsByProject.get(project.encodedDir) ?? [],
          )
        : tasksByOriginProject.get(project.encodedDir) ?? [],
    ]),
  );

  return {
    projects: representedProjects,
    sessions: representedProjects.flatMap((project) => project.sessions),
    tasks: representedProjects.flatMap(
      (project) => representedTasksByProject[project.encodedDir] ?? [],
    ),
    tasksByProject: representedTasksByProject,
  };
}
