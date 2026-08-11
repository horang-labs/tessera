import { toLinkedWorktreeSession } from '@/lib/worktrees/linked-worktree-presentation';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import { buildOriginProjectRepresentation } from '@/lib/projects/origin-project-representation';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

export interface ProjectViewWorkspaceStateDependencies {
  getProjects: () => readonly ProjectGroup[];
  getRetainedSessions: () => Readonly<Record<string, UnifiedSession>>;
  getTasksByProject: () => Readonly<Record<string, readonly TaskEntity[]>>;
  /** A missing key means the Project's Collections have not been loaded yet. */
  getCollectionsByProject: () => Readonly<Record<string, readonly Collection[]>>;
  hasUnreadNotification: (sessionId: string) => boolean;
  clearSessionUnread: (sessionId: string) => void;
  clearTaskSessionUnread: (sessionId: string) => void;
  markNotificationsRead: (sessionId: string) => void;
  acknowledgeSessionRead: (sessionId: string) => void;
  stopSession: (sessionId: string) => void;
  getOpenSurfaceSessionIds: () => readonly string[];
}

export interface ProjectViewWorkspaceState {
  /** Resolve one canonical Session, or its appearance in an explicit Project View. */
  resolveSession: (sessionId: string, projectViewId?: string) => UnifiedSession | undefined;
  /** Return one representative per canonical Session ID across every loaded source. */
  getCanonicalSessions: () => UnifiedSession[];
  /** Return the running canonical representatives used by every global surface. */
  getCanonicalRunningSessions: () => UnifiedSession[];
  /** Build the single origin-only representation used by global Project surfaces. */
  getOriginProjectRepresentation: () => ReturnType<typeof buildOriginProjectRepresentation>;
  /** Canonical unread state shared by tabs, rows, boards, Collections, and notifications. */
  isSessionUnread: (sessionId: string) => boolean;
  /** Clear every loaded unread representation and acknowledge the transition once. */
  markSessionRead: (sessionId: string) => boolean;
  /** Stop each globally running Session once and clear its unread state everywhere. */
  stopAllRunningSessions: () => string[];
  /** Sessions kept alive by materialized panels, tab snapshots, or Peek. */
  getOpenSessionIds: () => string[];
}

interface TaskSessionAppearance {
  task: TaskEntity;
  session: TaskSession;
}

function findTaskSessionAppearances(
  tasksByProject: Readonly<Record<string, readonly TaskEntity[]>>,
  sessionId: string,
): TaskSessionAppearance[] {
  const appearances: TaskSessionAppearance[] = [];
  for (const tasks of Object.values(tasksByProject)) {
    for (const task of tasks) {
      const session = task.sessions.find((candidate) => candidate.id === sessionId);
      if (session) appearances.push({ task, session });
    }
  }
  return appearances;
}

function chooseCanonicalTaskAppearance(
  appearances: readonly TaskSessionAppearance[],
): TaskSessionAppearance | undefined {
  return appearances.find(({ task, session }) => task.projectViewId === session.originProjectId)
    ?? appearances[0];
}

function chooseCanonicalDirectSession(
  projects: readonly ProjectGroup[],
  sessionId: string,
): UnifiedSession | undefined {
  let fallback: UnifiedSession | undefined;
  for (const project of projects) {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) continue;
    if (project.encodedDir === session.originProjectId) return session;
    fallback ??= session;
  }
  return fallback;
}

function resolveCollectionPlacement(
  collectionsByProject: Readonly<Record<string, readonly Collection[]>>,
  projectViewId: string,
  collectionId: string | undefined,
): string | undefined {
  if (!collectionId) return undefined;
  const knownCollections = collectionsByProject[projectViewId];
  if (!knownCollections) return collectionId;
  return knownCollections.some((collection) => collection.id === collectionId)
    ? collectionId
    : undefined;
}

export function createProjectViewWorkspaceState(
  dependencies: ProjectViewWorkspaceStateDependencies,
): ProjectViewWorkspaceState {
  const resolveCanonicalSession = (sessionId: string): UnifiedSession | undefined => {
    const direct = chooseCanonicalDirectSession(dependencies.getProjects(), sessionId);
    if (direct) return direct;

    const retained = dependencies.getRetainedSessions()[sessionId];
    if (retained) return retained;

    const taskAppearance = chooseCanonicalTaskAppearance(
      findTaskSessionAppearances(dependencies.getTasksByProject(), sessionId),
    );
    return taskAppearance
      ? toLinkedWorktreeSession(taskAppearance.task, taskAppearance.session)
      : undefined;
  };

  const resolveSession = (
    sessionId: string,
    projectViewId?: string,
  ): UnifiedSession | undefined => {
    const canonical = resolveCanonicalSession(sessionId);
    if (!canonical || !projectViewId) return canonical;

    const direct = dependencies.getProjects()
      .find((project) => project.encodedDir === projectViewId)
      ?.sessions.find((session) => session.id === sessionId);
    const taskAppearance = findTaskSessionAppearances(
      dependencies.getTasksByProject(),
      sessionId,
    ).find(({ task }) => task.projectViewId === projectViewId);
    const retained = dependencies.getRetainedSessions()[sessionId];

    const localCollectionId = direct?.collectionId
      ?? taskAppearance?.task.collectionId
      ?? (retained?.projectDir === projectViewId ? retained.collectionId : undefined);
    const collectionId = resolveCollectionPlacement(
      dependencies.getCollectionsByProject(),
      projectViewId,
      localCollectionId,
    );

    if (taskAppearance) {
      const appearance = toLinkedWorktreeSession(
        taskAppearance.task,
        taskAppearance.session,
        canonical,
      );
      return appearance.collectionId === collectionId
        ? appearance
        : { ...appearance, collectionId };
    }

    if (
      canonical.projectDir === projectViewId
      && canonical.collectionId === collectionId
    ) {
      return canonical;
    }

    return { ...canonical, projectDir: projectViewId, collectionId };
  };

  const getCanonicalSessions = (): UnifiedSession[] => {
    const sessionIds = new Set<string>();
    for (const project of dependencies.getProjects()) {
      for (const session of project.sessions) sessionIds.add(session.id);
    }
    for (const sessionId of Object.keys(dependencies.getRetainedSessions())) {
      sessionIds.add(sessionId);
    }
    for (const tasks of Object.values(dependencies.getTasksByProject())) {
      for (const task of tasks) {
        for (const session of task.sessions) sessionIds.add(session.id);
      }
    }

    return Array.from(sessionIds, resolveCanonicalSession)
      .filter((session): session is UnifiedSession => session !== undefined)
      .map((session) => session.projectDir === session.originProjectId
        ? session
        : { ...session, projectDir: session.originProjectId });
  };

  const getCanonicalRunningSessions = (): UnifiedSession[] => (
    getCanonicalSessions().filter(
      (session) => !session.archived && resolveSessionRuntimePresentation(session).canStop,
    )
  );

  const getOriginProjectRepresentation = () => buildOriginProjectRepresentation(
    [...dependencies.getProjects()],
    Object.fromEntries(
      Object.entries(dependencies.getTasksByProject()).map(([projectId, tasks]) => [
        projectId,
        [...tasks],
      ]),
    ),
    getCanonicalSessions(),
  );

  const isSessionUnread = (sessionId: string): boolean => (
    (resolveCanonicalSession(sessionId)?.unreadCount ?? 0) > 0
    || findTaskSessionAppearances(dependencies.getTasksByProject(), sessionId)
      .some(({ session }) => (session.unreadCount ?? 0) > 0)
    || dependencies.hasUnreadNotification(sessionId)
  );

  const markSessionRead = (sessionId: string): boolean => {
    if (!resolveCanonicalSession(sessionId) || !isSessionUnread(sessionId)) return false;

    dependencies.clearSessionUnread(sessionId);
    dependencies.clearTaskSessionUnread(sessionId);
    dependencies.markNotificationsRead(sessionId);
    dependencies.acknowledgeSessionRead(sessionId);
    return true;
  };

  const stopAllRunningSessions = (): string[] => {
    const sessionIds = getCanonicalRunningSessions().map((session) => session.id);
    for (const sessionId of sessionIds) {
      dependencies.stopSession(sessionId);
      markSessionRead(sessionId);
    }
    return sessionIds;
  };

  const getOpenSessionIds = (): string[] => {
    return [...new Set(dependencies.getOpenSurfaceSessionIds())];
  };

  return {
    resolveSession,
    getCanonicalSessions,
    getCanonicalRunningSessions,
    getOriginProjectRepresentation,
    isSessionUnread,
    markSessionRead,
    stopAllRunningSessions,
    getOpenSessionIds,
  };
}
