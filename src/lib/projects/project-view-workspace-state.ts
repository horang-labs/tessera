import { toLinkedWorktreeSession } from '@/lib/worktrees/linked-worktree-presentation';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity, TaskSession, WorkflowStatus } from '@/types/task-entity';

export interface TaskDerivedWorkspaceMutation {
  taskId: string;
  /** Required for Project-local fields such as Collection placement. */
  projectViewId?: string;
  workflowStatus?: WorkflowStatus;
  collectionId?: string | null;
  archived?: boolean;
}

export type WorkspaceMutationRollback = () => void;

export interface ProjectViewWorkspaceStateDependencies {
  getProjects: () => readonly ProjectGroup[];
  getRetainedSessions: () => Readonly<Record<string, UnifiedSession>>;
  getTasksByProject: () => Readonly<Record<string, readonly TaskEntity[]>>;
  /** A missing key means the Project's Collections have not been loaded yet. */
  getCollectionsByProject: () => Readonly<Record<string, readonly Collection[]>>;
  replaceProjects: (projects: ProjectGroup[]) => void;
  replaceRetainedSessions: (sessions: Record<string, UnifiedSession>) => void;
  replaceTasksByProject: (tasks: Record<string, TaskEntity[]>) => void;
  hasUnreadNotification: (sessionId: string) => boolean;
  clearSessionUnread: (sessionId: string) => void;
  clearTaskSessionUnread: (sessionId: string) => void;
  markNotificationsRead: (sessionId: string) => void;
  acknowledgeSessionRead: (sessionId: string) => void;
}

export interface ProjectViewWorkspaceState {
  /** Resolve one canonical Session, or its appearance in an explicit Project View. */
  resolveSession: (sessionId: string, projectViewId?: string) => UnifiedSession | undefined;
  /** Return one representative per canonical Session ID across every loaded source. */
  getCanonicalSessions: () => UnifiedSession[];
  /** Canonical unread state shared by tabs, rows, boards, Collections, and notifications. */
  isSessionUnread: (sessionId: string) => boolean;
  /** Clear every loaded unread representation and acknowledge the transition once. */
  markSessionRead: (sessionId: string) => boolean;
  /** Apply one Task-derived optimistic transition to every loaded appearance. */
  applyTaskMutation: (
    mutation: TaskDerivedWorkspaceMutation,
  ) => WorkspaceMutationRollback | undefined;
  /** Apply server-confirmed Todo -> Doing promotion through the same transition seam. */
  promoteTodoTasks: (taskIds: readonly string[]) => WorkspaceMutationRollback | undefined;
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

function updateProjectWorkflowStatus(
  project: ProjectGroup,
  linkedSessionIds: ReadonlySet<string>,
  taskId: string,
  workflowStatus: WorkflowStatus,
): ProjectGroup {
  const previousStatuses: WorkflowStatus[] = [];
  const sessions = project.sessions.map((session) => {
    if (session.taskId !== taskId && !linkedSessionIds.has(session.id)) return session;
    const previousStatus = session.workflowStatus ?? 'todo';
    if (!session.archived && previousStatus !== workflowStatus) previousStatuses.push(previousStatus);
    return { ...session, workflowStatus };
  });
  if (previousStatuses.length === 0 && sessions.every((session, index) => session === project.sessions[index])) {
    return project;
  }
  if (!project.countByStatus || previousStatuses.length === 0) return { ...project, sessions };

  const countByStatus = { ...project.countByStatus };
  for (const previousStatus of previousStatuses) {
    countByStatus[previousStatus] = Math.max(0, (countByStatus[previousStatus] ?? 0) - 1);
    countByStatus[workflowStatus] = (countByStatus[workflowStatus] ?? 0) + 1;
  }
  return { ...project, sessions, countByStatus };
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

    return Array.from(sessionIds, resolveCanonicalSession).filter(
      (session): session is UnifiedSession => session !== undefined,
    );
  };

  const isSessionUnread = (sessionId: string): boolean => (
    (resolveCanonicalSession(sessionId)?.unreadCount ?? 0) > 0
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

  const applyTaskMutations = (
    mutations: readonly TaskDerivedWorkspaceMutation[],
  ): WorkspaceMutationRollback | undefined => {
    if (mutations.length === 0) return undefined;

    const previousProjects = [...dependencies.getProjects()];
    const previousRetainedSessions = { ...dependencies.getRetainedSessions() };
    const previousTasksByProject = Object.fromEntries(
      Object.entries(dependencies.getTasksByProject()).map(([projectId, tasks]) => [
        projectId,
        [...tasks],
      ]),
    );
    let projects = previousProjects;
    let retainedSessions = previousRetainedSessions;
    let tasksByProject = previousTasksByProject;

    for (const mutation of mutations) {
      const taskAppearances = Object.values(tasksByProject)
        .flat()
        .filter((task) => task.id === mutation.taskId);
      if (taskAppearances.length === 0) continue;

      const linkedSessionIds = new Set(
        taskAppearances.flatMap((task) => task.sessions.map((session) => session.id)),
      );
      const hasCollectionMutation = Object.hasOwn(mutation, 'collectionId');
      const hasArchiveMutation = Object.hasOwn(mutation, 'archived');

      tasksByProject = Object.fromEntries(
        Object.entries(tasksByProject).map(([projectId, tasks]) => {
          if (mutation.archived === true) {
            return [projectId, tasks.filter((task) => task.id !== mutation.taskId)];
          }
          return [
            projectId,
            tasks.map((task) => {
              if (task.id !== mutation.taskId) return task;
              return {
                ...task,
                ...(mutation.workflowStatus !== undefined && {
                  workflowStatus: mutation.workflowStatus,
                }),
                ...(hasCollectionMutation && {
                  collectionId: projectId === mutation.projectViewId
                    ? mutation.collectionId ?? undefined
                    : undefined,
                }),
                ...(hasArchiveMutation && {
                  archived: mutation.archived,
                  archivedAt: mutation.archived ? new Date().toISOString() : undefined,
                }),
              };
            }),
          ];
        }),
      );

      if (mutation.workflowStatus !== undefined) {
        projects = projects.map((project) => updateProjectWorkflowStatus(
          project,
          linkedSessionIds,
          mutation.taskId,
          mutation.workflowStatus!,
        ));
      }

      projects = projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) => {
          if (session.taskId !== mutation.taskId && !linkedSessionIds.has(session.id)) return session;
          return {
            ...session,
            ...(hasCollectionMutation && {
              collectionId: project.encodedDir === mutation.projectViewId
                ? mutation.collectionId ?? undefined
                : undefined,
            }),
            ...(hasArchiveMutation && {
              archived: mutation.archived,
              archivedAt: mutation.archived ? new Date().toISOString() : undefined,
              isReadOnly: mutation.archived,
            }),
          };
        }),
      }));

      retainedSessions = Object.fromEntries(
        Object.entries(retainedSessions).map(([sessionId, session]) => {
          if (session.taskId !== mutation.taskId && !linkedSessionIds.has(session.id)) {
            return [sessionId, session];
          }
          return [sessionId, {
            ...session,
            ...(mutation.workflowStatus !== undefined && {
              workflowStatus: mutation.workflowStatus,
            }),
            ...(hasCollectionMutation && {
              collectionId: session.projectDir === mutation.projectViewId
                ? mutation.collectionId ?? undefined
                : undefined,
            }),
            ...(hasArchiveMutation && {
              archived: mutation.archived,
              archivedAt: mutation.archived ? new Date().toISOString() : undefined,
              isReadOnly: mutation.archived,
            }),
          }];
        }),
      );
    }

    dependencies.replaceTasksByProject(tasksByProject);
    dependencies.replaceProjects(projects);
    dependencies.replaceRetainedSessions(retainedSessions);

    return () => {
      dependencies.replaceTasksByProject(previousTasksByProject);
      dependencies.replaceProjects(previousProjects);
      dependencies.replaceRetainedSessions(previousRetainedSessions);
    };
  };

  const applyTaskMutation = (
    mutation: TaskDerivedWorkspaceMutation,
  ): WorkspaceMutationRollback | undefined => applyTaskMutations([mutation]);

  const promoteTodoTasks = (
    taskIds: readonly string[],
  ): WorkspaceMutationRollback | undefined => {
    const targets = new Set(taskIds);
    const todoTaskIds = new Set<string>();
    for (const tasks of Object.values(dependencies.getTasksByProject())) {
      for (const task of tasks) {
        if (targets.has(task.id) && task.workflowStatus === 'todo') todoTaskIds.add(task.id);
      }
    }
    return applyTaskMutations(Array.from(todoTaskIds, (taskId) => ({
      taskId,
      workflowStatus: 'in_progress',
    })));
  };

  return {
    resolveSession,
    getCanonicalSessions,
    isSessionUnread,
    markSessionRead,
    applyTaskMutation,
    promoteTodoTasks,
  };
}
