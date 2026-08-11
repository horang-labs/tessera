import { toLinkedWorktreeSession } from '@/lib/worktrees/linked-worktree-presentation';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import { buildOriginProjectRepresentation } from '@/lib/projects/origin-project-representation';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity, TaskSession, WorkflowStatus } from '@/types/task-entity';
import type { PreparationStatus } from '@/lib/projects/preparation-status-policy';

export interface TaskDerivedWorkspaceMutation {
  taskId: string;
  /** Linked canonical Session whose title changed with a single-Session Task. */
  sessionId?: string;
  /** Required for Project-local fields such as Collection placement. */
  projectViewId?: string;
  title?: string;
  workflowStatus?: WorkflowStatus;
  preparationStatus?: PreparationStatus;
  collectionId?: string | null;
  archived?: boolean;
}

export interface WorkspaceMutationIdentity {
  /** Stable origin Project supplied as a compatibility fallback. */
  projectId?: string;
  /** Canonical Worktree Task identity shared by every Project appearance. */
  taskId?: string;
  /** Canonical Session identity shared by direct and Task projections. */
  sessionId?: string;
  /** Server-resolved candidates, intersected with this window's loaded views. */
  affectedProjectIds?: readonly string[];
}

export interface SessionRestoreWorkspaceMutation {
  session: UnifiedSession;
  taskSession?: TaskSession;
  affectedProjectIds: readonly string[];
}

export interface TaskRestoreWorkspaceMutation {
  task: TaskEntity;
  affectedProjectIds: readonly string[];
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
  /** Loaded Project Views whose cached appearance contains the canonical entity. */
  getAffectedProjectViewIds: (identity: WorkspaceMutationIdentity) => string[];
  /** Apply a confirmed Session archive transition before active-list refetches. */
  applySessionArchiveMutation: (
    sessionId: string,
    archived: boolean,
  ) => WorkspaceMutationRollback;
  /** Materialize a restored Session into every loaded Project appearance. */
  applySessionRestoreMutation: (
    mutation: SessionRestoreWorkspaceMutation,
  ) => WorkspaceMutationRollback;
  /** Materialize a restored Worktree Task into every loaded Project appearance. */
  applyTaskRestoreMutation: (
    mutation: TaskRestoreWorkspaceMutation,
  ) => WorkspaceMutationRollback;
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

  const getAffectedProjectViewIds = (
    identity: WorkspaceMutationIdentity,
  ): string[] => {
    const projectViewIds = new Set<string>();
    const loadedProjectViewIds = new Set([
      ...dependencies.getProjects().map((project) => project.encodedDir),
      ...Object.keys(dependencies.getTasksByProject()),
    ]);
    if (identity.projectId) projectViewIds.add(identity.projectId);
    for (const projectViewId of identity.affectedProjectIds ?? []) {
      if (loadedProjectViewIds.has(projectViewId)) projectViewIds.add(projectViewId);
    }

    let taskId = identity.taskId;
    if (identity.sessionId) {
      for (const project of dependencies.getProjects()) {
        const session = project.sessions.find((candidate) => candidate.id === identity.sessionId);
        if (!session) continue;
        projectViewIds.add(project.encodedDir);
        taskId ??= session.taskId;
      }

      const retained = dependencies.getRetainedSessions()[identity.sessionId];
      if (retained) {
        projectViewIds.add(retained.projectDir);
        taskId ??= retained.taskId;
      }

      for (const [projectViewId, tasks] of Object.entries(dependencies.getTasksByProject())) {
        const task = tasks.find((candidate) =>
          candidate.sessions.some((session) => session.id === identity.sessionId)
        );
        if (!task) continue;
        projectViewIds.add(projectViewId);
        taskId ??= task.id;
      }
    }

    if (taskId) {
      for (const [projectViewId, tasks] of Object.entries(dependencies.getTasksByProject())) {
        if (tasks.some((task) => task.id === taskId)) projectViewIds.add(projectViewId);
      }
      for (const project of dependencies.getProjects()) {
        if (project.sessions.some((session) => session.taskId === taskId)) {
          projectViewIds.add(project.encodedDir);
        }
      }
    }

    return [...projectViewIds];
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

      const linkedSessionIds = new Set(
        taskAppearances.flatMap((task) => task.sessions.map((session) => session.id)),
      );
      if (mutation.sessionId) linkedSessionIds.add(mutation.sessionId);
      const hasSessionAppearance = projects.some((project) => project.sessions.some((session) => (
        session.taskId === mutation.taskId || linkedSessionIds.has(session.id)
      ))) || Object.values(retainedSessions).some((session) => (
        session.taskId === mutation.taskId || linkedSessionIds.has(session.id)
      ));
      if (taskAppearances.length === 0 && !hasSessionAppearance) continue;
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
                ...(mutation.title !== undefined && { title: mutation.title }),
                ...(mutation.workflowStatus !== undefined && {
                  workflowStatus: mutation.workflowStatus,
                }),
                ...(mutation.preparationStatus !== undefined && {
                  preparationStatus: mutation.preparationStatus,
                }),
                ...(mutation.title !== undefined && mutation.sessionId && {
                  sessions: task.sessions.map((session) => session.id === mutation.sessionId
                    ? { ...session, title: mutation.title! }
                    : session),
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
            ...(mutation.title !== undefined && session.id === mutation.sessionId && {
              title: mutation.title,
              hasCustomTitle: true,
            }),
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
            ...(mutation.title !== undefined && session.id === mutation.sessionId && {
              title: mutation.title,
              hasCustomTitle: true,
            }),
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

  const applySessionArchiveMutation = (
    sessionId: string,
    archived: boolean,
  ): WorkspaceMutationRollback => {
    const previousProjects = [...dependencies.getProjects()];
    const previousRetainedSessions = { ...dependencies.getRetainedSessions() };
    const previousTasksByProject = Object.fromEntries(
      Object.entries(dependencies.getTasksByProject()).map(([projectId, tasks]) => [
        projectId,
        [...tasks],
      ]),
    );
    const archivedAt = archived ? new Date().toISOString() : undefined;
    const updateSession = (session: UnifiedSession): UnifiedSession => ({
      ...session,
      archived,
      archivedAt,
      isReadOnly: archived,
    });

    dependencies.replaceProjects(previousProjects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) =>
        session.id === sessionId ? updateSession(session) : session
      ),
    })));
    dependencies.replaceRetainedSessions(Object.fromEntries(
      Object.entries(previousRetainedSessions).map(([id, session]) => [
        id,
        id === sessionId ? updateSession(session) : session,
      ]),
    ));
    dependencies.replaceTasksByProject(Object.fromEntries(
      Object.entries(previousTasksByProject).map(([projectId, tasks]) => [
        projectId,
        archived
          ? tasks.map((task) => ({
              ...task,
              sessions: task.sessions.filter((session) => session.id !== sessionId),
            }))
          : tasks,
      ]),
    ));

    return () => {
      dependencies.replaceTasksByProject(previousTasksByProject);
      dependencies.replaceProjects(previousProjects);
      dependencies.replaceRetainedSessions(previousRetainedSessions);
    };
  };

  const applySessionRestoreMutation = (
    mutation: SessionRestoreWorkspaceMutation,
  ): WorkspaceMutationRollback => {
    const previousProjects = [...dependencies.getProjects()];
    const previousRetainedSessions = { ...dependencies.getRetainedSessions() };
    const previousTasksByProject = Object.fromEntries(
      Object.entries(dependencies.getTasksByProject()).map(([projectId, tasks]) => [
        projectId,
        [...tasks],
      ]),
    );
    const projectViewIds = new Set(getAffectedProjectViewIds({
      projectId: mutation.session.originProjectId,
      sessionId: mutation.session.id,
      taskId: mutation.session.taskId,
      affectedProjectIds: mutation.affectedProjectIds,
    }));
    const restoredSession = {
      ...mutation.session,
      archived: false,
      archivedAt: undefined,
      isReadOnly: false,
    };

    dependencies.replaceTasksByProject(Object.fromEntries(
      Object.entries(previousTasksByProject).map(([projectId, tasks]) => [
        projectId,
        !projectViewIds.has(projectId) || !restoredSession.taskId || !mutation.taskSession
          ? tasks
          : tasks.map((task) => (
              task.id !== restoredSession.taskId
              || task.sessions.some((session) => session.id === restoredSession.id)
                ? task
                : { ...task, sessions: [...task.sessions, mutation.taskSession!] }
            )),
      ]),
    ));
    dependencies.replaceProjects(previousProjects.map((project) => {
      if (
        project.encodedDir !== restoredSession.projectDir
        || project.sessions.some((session) => session.id === restoredSession.id)
      ) {
        return project;
      }
      return {
        ...project,
        sessions: [...project.sessions, {
          ...restoredSession,
          projectDir: project.encodedDir,
          collectionId: project.encodedDir === restoredSession.projectDir
            ? restoredSession.collectionId
            : undefined,
        }],
      };
    }));
    dependencies.replaceRetainedSessions({
      ...previousRetainedSessions,
      [restoredSession.id]: restoredSession,
    });

    return () => {
      dependencies.replaceTasksByProject(previousTasksByProject);
      dependencies.replaceProjects(previousProjects);
      dependencies.replaceRetainedSessions(previousRetainedSessions);
    };
  };

  const applyTaskRestoreMutation = (
    mutation: TaskRestoreWorkspaceMutation,
  ): WorkspaceMutationRollback => {
    const previousProjects = [...dependencies.getProjects()];
    const previousRetainedSessions = { ...dependencies.getRetainedSessions() };
    const previousTasksByProject = Object.fromEntries(
      Object.entries(dependencies.getTasksByProject()).map(([projectId, tasks]) => [
        projectId,
        [...tasks],
      ]),
    );
    const projectViewIds = new Set(getAffectedProjectViewIds({
      projectId: mutation.task.projectId,
      taskId: mutation.task.id,
      affectedProjectIds: mutation.affectedProjectIds,
    }));
    const restoredTasks = new Map<string, TaskEntity>();
    for (const projectViewId of projectViewIds) {
      restoredTasks.set(projectViewId, {
        ...mutation.task,
        projectViewId,
        archived: false,
        archivedAt: undefined,
        collectionId: projectViewId === mutation.task.projectId
          ? mutation.task.collectionId
          : undefined,
      });
    }

    dependencies.replaceTasksByProject(Object.fromEntries(
      Object.entries(previousTasksByProject).map(([projectId, tasks]) => {
        const restoredTask = restoredTasks.get(projectId);
        return [
          projectId,
          !restoredTask || tasks.some((task) => task.id === restoredTask.id)
            ? tasks
            : [...tasks, restoredTask],
        ];
      }),
    ));
    dependencies.replaceProjects(previousProjects.map((project) => {
      const restoredTask = restoredTasks.get(project.encodedDir);
      if (!restoredTask || project.encodedDir !== restoredTask.workDir) return project;
      const existingSessionIds = new Set(project.sessions.map((session) => session.id));
      const sessions = restoredTask.sessions
        .filter((session) => !existingSessionIds.has(session.id))
        .map((session) => toLinkedWorktreeSession(restoredTask, session));
      return sessions.length > 0
        ? { ...project, sessions: [...project.sessions, ...sessions] }
        : project;
    }));
    dependencies.replaceRetainedSessions({
      ...previousRetainedSessions,
      ...Object.fromEntries(mutation.task.sessions.map((session) => [
        session.id,
        toLinkedWorktreeSession(mutation.task, session),
      ])),
    });

    return () => {
      dependencies.replaceTasksByProject(previousTasksByProject);
      dependencies.replaceProjects(previousProjects);
      dependencies.replaceRetainedSessions(previousRetainedSessions);
    };
  };

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
    getCanonicalRunningSessions,
    getOriginProjectRepresentation,
    isSessionUnread,
    markSessionRead,
    stopAllRunningSessions,
    getOpenSessionIds,
    getAffectedProjectViewIds,
    applySessionArchiveMutation,
    applySessionRestoreMutation,
    applyTaskRestoreMutation,
    applyTaskMutation,
    promoteTodoTasks,
  };
}
