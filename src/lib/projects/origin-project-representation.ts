import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';

export function getSessionOriginProjectId(session: UnifiedSession): string {
  return session.originProjectId ?? session.projectDir;
}

/** Remove Project View appearances that belong to another Project's origin. */
export function getTaskOriginProjectRepresentation(task: TaskEntity): TaskEntity {
  const sessions = task.sessions.filter(
    (session) => (session.originProjectId ?? task.projectId) === task.projectId,
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

/**
 * Global aggregate surfaces deliberately use the persisted origin Project as
 * the one representative location. Alternate Project View appearances are
 * omitted instead of being deduplicated after presentation.
 */
export function buildOriginProjectRepresentation(
  projects: ProjectGroup[],
  tasksByProject: Record<string, TaskEntity[]>,
) {
  const seenSessionIds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const sessionsByProject = new Map<string, UnifiedSession[]>();
  const tasksByOriginProject = new Map<string, TaskEntity[]>();

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
      tasksByOriginProject.get(project.encodedDir) ?? [],
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

/** Stable canonical Session rows for navigation-only global surfaces. */
export function getCanonicalSessionRepresentatives(
  projects: ProjectGroup[],
): UnifiedSession[] {
  const representatives = new Map<string, UnifiedSession>();

  for (const project of projects) {
    for (const session of project.sessions) {
      const originProjectId = getSessionOriginProjectId(session);
      const current = representatives.get(session.id);
      const isOriginAppearance = project.encodedDir === originProjectId;
      if (!current || isOriginAppearance) {
        representatives.set(session.id, {
          ...session,
          projectDir: originProjectId,
          originProjectId,
        });
      }
    }
  }

  return Array.from(representatives.values());
}

export function getCanonicalRunningSessionRepresentatives(
  projects: ProjectGroup[],
): UnifiedSession[] {
  return getCanonicalSessionRepresentatives(projects).filter((session) => session.isRunning);
}
