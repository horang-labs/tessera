import { create } from 'zustand';
import type { TaskEntity, WorkflowStatus } from '@/types/task-entity';
import { useSessionStore } from './session-store';
import { useTabStore } from './tab-store';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { toast } from './notification-store';

interface LoadTasksOptions {
  setCurrent?: boolean;
}

interface QueuedProjectLoad {
  setCurrent: boolean;
}

interface TaskPrStatusCacheEntry {
  prStatus: TaskEntity['prStatus'];
  prUnsupported: boolean;
  remoteBranchExists: boolean | undefined;
}

/** A child session lifted out of its task, kept so the removal can be undone. */
export interface RemovedTaskSession {
  taskId: string;
  index: number;
  session: TaskEntity['sessions'][number];
}

interface TaskState {
  /** Tasks for the currently focused project (kept for existing consumers) */
  tasks: TaskEntity[];
  /** Cached tasks keyed by project ID so All Projects mode can reuse list view */
  tasksByProject: Record<string, TaskEntity[]>;
  /** Latest PR updates keyed by task ID, including tasks not currently loaded in board caches. */
  prStatusByTaskId: Record<string, TaskPrStatusCacheEntry>;
  /** Whether the current project's tasks have been loaded */
  loaded: boolean;
  /** Per-project load marker for cached task data */
  loadedProjects: Record<string, boolean>;
  /** Project whose tasks are currently exposed via `tasks` */
  currentProjectId: string | null;
  /** In-flight task fetches keyed by project ID */
  loadingProjectIds: Record<string, boolean>;
  /** Follow-up fetches requested while a project fetch is already in flight */
  queuedProjectLoads: Record<string, QueuedProjectLoad>;

  /** Load tasks for a project from API */
  loadTasks: (projectId: string, options?: LoadTasksOptions) => Promise<void>;
  /** Create a new task */
  createTask: (params: {
    projectId: string;
    title: string;
    collectionId?: string;
    workflowStatus?: WorkflowStatus;
    worktreeBranch?: string;
  }) => Promise<TaskEntity | null>;
  /** Update a task (optimistic) */
  updateTask: (
    id: string,
    patch: {
      title?: string;
      collectionId?: string | null;
      workflowStatus?: WorkflowStatus;
      worktreeBranch?: string;
      summary?: string;
    }
  ) => Promise<boolean>;
  /** Delete a Worktree checkout while retaining its archived canonical records. */
  deleteWorktree: (taskId: string) => Promise<boolean>;
  /** Archive/restore a task and all child sessions as one unit */
  toggleTaskArchive: (id: string, archived: boolean) => Promise<boolean>;
  /** Reorder tasks (optimistic + server sync) */
  reorderTasks: (orderedIds: string[], projectId?: string) => void;
  /** Get a task from cache by ID */
  getTask: (id: string) => TaskEntity | undefined;
  /** Get a task from cache by any child session ID */
  getTaskBySessionId: (sessionId: string) => TaskEntity | undefined;
  /** Get cached tasks for a specific project */
  getTasksForProject: (projectId: string) => TaskEntity[];
  /**
   * Update a linked session title in local task cache.
   * Single-session tasks also mirror the parent task title.
   */
  syncLinkedTaskTitle: (sessionId: string, title: string) => void;
  /**
   * Drop a child session from its task after that session alone was archived.
   * Returns what was removed so a failed archive can put it back in place.
   */
  removeTaskSession: (sessionId: string) => RemovedTaskSession | null;
  /** Re-insert a session removed by `removeTaskSession` at its original position. */
  restoreTaskSession: (removed: RemovedTaskSession) => void;
  /** Replace a collection reference across cached tasks */
  replaceCollectionId: (fromCollectionId: string, toCollectionId: string | null) => void;
  /** Clear cached worktree metadata for tasks whose managed worktree was removed */
  clearTaskWorktrees: (taskIds: string[]) => void;
  /** Apply diff stats to tasks matching the given ids. */
  applyDiffStatsUpdate: (taskIds: string[], diffStats: TaskEntity['diffStats']) => void;
  /** Apply server-confirmed Todo -> Doing promotions without issuing another PATCH. */
  applyWorkflowStatusPromotions: (taskIds: string[]) => void;
  /** Apply a PR status update pushed from the server. */
  applyPrStatusUpdate: (
    taskId: string,
    prStatus: TaskEntity['prStatus'],
    prUnsupported: boolean,
    remoteBranchExists: boolean | undefined,
  ) => void;
  /** Insert an optimistic placeholder task (isPending=true) at the top of the project list */
  addPendingTask: (task: TaskEntity) => void;
  /** Remove a pending task (e.g. creation failed) */
  removePendingTask: (tempId: string, projectId: string) => void;
  /** Replace a pending placeholder with the real task returned from the server */
  finalizePendingTask: (tempId: string, realTask: TaskEntity) => void;
}

function applyTaskPatch(
  task: TaskEntity,
  patch: {
    title?: string;
    collectionId?: string | null;
    workflowStatus?: WorkflowStatus;
    worktreeBranch?: string;
    summary?: string;
  }
): TaskEntity {
  return {
    ...task,
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.collectionId !== undefined && { collectionId: patch.collectionId ?? undefined }),
    ...(patch.workflowStatus !== undefined && { workflowStatus: patch.workflowStatus }),
    ...(patch.worktreeBranch !== undefined && { worktreeBranch: patch.worktreeBranch }),
    ...(patch.summary !== undefined && { summary: patch.summary }),
  };
}

function syncLinkedTaskTitleInList(tasks: TaskEntity[], sessionId: string, title: string): TaskEntity[] {
  let changed = false;
  const nextTasks = tasks.map((task) => {
    const sessionIndex = task.sessions.findIndex((session) => session.id === sessionId);
    if (sessionIndex === -1) {
      return task;
    }

    const shouldSyncTaskTitle = task.sessions.length === 1 && task.title !== title;
    const shouldSyncSessionTitle = task.sessions[sessionIndex].title !== title;

    if (!shouldSyncTaskTitle && !shouldSyncSessionTitle) {
      return task;
    }

    changed = true;
    const nextSessions = shouldSyncSessionTitle
      ? task.sessions.map((session) =>
          session.id === sessionId ? { ...session, title } : session
        )
      : task.sessions;

    return {
      ...task,
      ...(shouldSyncTaskTitle && { title }),
      sessions: nextSessions,
    };
  });

  return changed ? nextTasks : tasks;
}

function removeTaskSessionInList(tasks: TaskEntity[], sessionId: string): TaskEntity[] {
  let changed = false;
  const nextTasks = tasks.map((task) => {
    if (!task.sessions.some((session) => session.id === sessionId)) {
      return task;
    }

    changed = true;
    return { ...task, sessions: task.sessions.filter((session) => session.id !== sessionId) };
  });

  return changed ? nextTasks : tasks;
}

function restoreTaskSessionInList(tasks: TaskEntity[], removed: RemovedTaskSession): TaskEntity[] {
  let changed = false;
  const nextTasks = tasks.map((task) => {
    if (task.id !== removed.taskId || task.sessions.some((session) => session.id === removed.session.id)) {
      return task;
    }

    changed = true;
    const sessions = [...task.sessions];
    sessions.splice(Math.min(removed.index, sessions.length), 0, removed.session);
    return { ...task, sessions };
  });

  return changed ? nextTasks : tasks;
}

function replaceCollectionIdInList(
  tasks: TaskEntity[],
  fromCollectionId: string,
  toCollectionId: string | null
): TaskEntity[] {
  let changed = false;

  const nextTasks = tasks.map((task) => {
    if (task.collectionId !== fromCollectionId) {
      return task;
    }

    changed = true;
    return { ...task, collectionId: toCollectionId ?? undefined };
  });

  return changed ? nextTasks : tasks;
}

function clearTaskWorktreesInList(tasks: TaskEntity[], targetTaskIds: Set<string>): TaskEntity[] {
  let changed = false;

  const nextTasks = tasks.map((task) => {
    if (!targetTaskIds.has(task.id) || (!task.worktreeBranch && !task.workDir)) {
      return task;
    }

    changed = true;
    return {
      ...task,
      worktreeBranch: undefined,
      workDir: undefined,
    };
  });

  return changed ? nextTasks : tasks;
}

function updateProjectCache(
  state: TaskState,
  projectId: string,
  projectTasks: TaskEntity[],
  syncCurrentProject: boolean
) {
  return {
    tasksByProject: {
      ...state.tasksByProject,
      [projectId]: projectTasks,
    },
    loadedProjects: {
      ...state.loadedProjects,
      [projectId]: true,
    },
    ...(syncCurrentProject
      ? {
          tasks: projectTasks,
          currentProjectId: projectId,
          loaded: true,
        }
      : {}),
  };
}

function removeProjectLoadingFlag(state: TaskState, projectId: string) {
  const nextLoading = { ...state.loadingProjectIds };
  delete nextLoading[projectId];
  return nextLoading;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  tasksByProject: {},
  prStatusByTaskId: {},
  loaded: false,
  loadedProjects: {},
  currentProjectId: null,
  loadingProjectIds: {},
  queuedProjectLoads: {},

  loadTasks: async (projectId, options) => {
    const shouldSetCurrent = options?.setCurrent !== false;
    if (get().loadingProjectIds[projectId]) {
      set((state) => {
        const previous = state.queuedProjectLoads[projectId];
        return {
          queuedProjectLoads: {
            ...state.queuedProjectLoads,
            [projectId]: {
              setCurrent: shouldSetCurrent || previous?.setCurrent === true,
            },
          },
          ...(shouldSetCurrent
            ? {
                currentProjectId: projectId,
                loaded: false,
              }
            : {}),
        };
      });
      return;
    }

    set((state) => ({
      loadingProjectIds: {
        ...state.loadingProjectIds,
        [projectId]: true,
      },
      ...(shouldSetCurrent
        ? {
            currentProjectId: projectId,
            loaded: false,
          }
        : {}),
    }));

    try {
      const res = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const fetchedTasks: TaskEntity[] = data.tasks ?? [];

      set((state) => {
        const existing = state.tasksByProject[projectId] ?? [];
        const pending = existing.filter((task) => task.isPending);
        const projectTasks = pending.length > 0 ? [...pending, ...fetchedTasks] : fetchedTasks;
        return {
          ...updateProjectCache(
            state,
            projectId,
            projectTasks,
            shouldSetCurrent || state.currentProjectId === projectId
          ),
        };
      });
    } catch {
      // Silently fail -- tasks will just not appear
    } finally {
      const queuedLoad = get().queuedProjectLoads[projectId];
      set((state) => ({
        loadingProjectIds: removeProjectLoadingFlag(state, projectId),
        queuedProjectLoads: Object.fromEntries(
          Object.entries(state.queuedProjectLoads).filter(([id]) => id !== projectId)
        ),
      }));
      if (queuedLoad) {
        void get().loadTasks(projectId, { setCurrent: queuedLoad.setCurrent });
      }
    }
  },

  createTask: async (params) => {
    try {
      const res = await fetchWithClientId('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) return null;

      const data = await res.json();
      const task: TaskEntity = data.task;

      set((state) => {
        const projectTasks = [task, ...(state.tasksByProject[task.projectViewId] ?? [])];
        return {
          ...updateProjectCache(
            state,
            task.projectViewId,
            projectTasks,
            state.currentProjectId === task.projectViewId
          ),
        };
      });

      return task;
    } catch {
      return null;
    }
  },

  updateTask: async (id, patch) => {
    const existingTask = get().getTask(id);
    const originProjectId = existingTask?.projectId;
    const affectedProjectIds = Object.entries(get().tasksByProject)
      .filter(([, tasks]) => tasks.some((task) => task.id === id))
      .map(([projectId]) => projectId);
    const linkedSessionId = patch.title && existingTask?.sessions.length === 1
      ? existingTask.sessions[0].id
      : null;
    const primarySessionId = existingTask?.sessions[0]?.id;
    const previousSessionWorkflowStatus = primarySessionId
      ? useSessionStore.getState().getSession(primarySessionId)?.workflowStatus ?? existingTask?.workflowStatus ?? 'todo'
      : existingTask?.workflowStatus;
    const shouldSyncWorkflowStatus = patch.workflowStatus !== undefined
      && previousSessionWorkflowStatus !== undefined
      && previousSessionWorkflowStatus !== patch.workflowStatus;
    const previousCollectionId = existingTask?.collectionId;
    const shouldSyncCollectionId = patch.collectionId !== undefined
      && previousCollectionId !== patch.collectionId;
    const previousLinkedSession = linkedSessionId
      ? useSessionStore.getState().getSession(linkedSessionId)
      : undefined;

    const canonicalPatch = { ...patch };
    delete canonicalPatch.collectionId;
    set((state) => {
      const patchList = (tasks: TaskEntity[], includeOriginCollection: boolean) =>
        tasks.map((task) => task.id === id
          ? applyTaskPatch(task, includeOriginCollection ? patch : canonicalPatch)
          : task);
      return {
        tasks: patchList(state.tasks, state.currentProjectId === originProjectId),
        tasksByProject: Object.fromEntries(
          Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
            projectId,
            patchList(tasks, projectId === originProjectId),
          ]),
        ),
      };
    });

    const reloadAffectedProjectViews = async () => {
      await Promise.all(affectedProjectIds.map((projectId) => get().loadTasks(projectId, {
        setCurrent: get().currentProjectId === projectId,
      })));
    };

    if (shouldSyncWorkflowStatus && previousSessionWorkflowStatus) {
      useSessionStore.getState().syncTaskWorkflowStatus(
        id,
        previousSessionWorkflowStatus,
        patch.workflowStatus!,
      );
    }

    if (shouldSyncCollectionId) {
      useSessionStore.getState().syncTaskCollectionId(id, patch.collectionId ?? null);
    }

    if (linkedSessionId && patch.title) {
      useSessionStore.getState().updateSessionTitle(linkedSessionId, patch.title, true);
    }

    try {
      const res = await fetchWithClientId(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        if (linkedSessionId && previousLinkedSession) {
          useSessionStore.getState().updateSessionTitle(
            linkedSessionId,
            previousLinkedSession.title,
            previousLinkedSession.hasCustomTitle
          );
        }
        if (shouldSyncWorkflowStatus && previousSessionWorkflowStatus) {
          useSessionStore.getState().syncTaskWorkflowStatus(
            id,
            patch.workflowStatus!,
            previousSessionWorkflowStatus,
          );
        }
        if (shouldSyncCollectionId) {
          useSessionStore.getState().syncTaskCollectionId(id, previousCollectionId ?? null);
        }
        await reloadAffectedProjectViews();
        return false;
      }
      return true;
    } catch {
      if (linkedSessionId && previousLinkedSession) {
        useSessionStore.getState().updateSessionTitle(
          linkedSessionId,
          previousLinkedSession.title,
          previousLinkedSession.hasCustomTitle
        );
      }
      if (shouldSyncWorkflowStatus && previousSessionWorkflowStatus) {
        useSessionStore.getState().syncTaskWorkflowStatus(
          id,
          patch.workflowStatus!,
          previousSessionWorkflowStatus,
        );
      }
      if (shouldSyncCollectionId) {
        useSessionStore.getState().syncTaskCollectionId(id, previousCollectionId ?? null);
      }
      await reloadAffectedProjectViews();
      return false;
    }
  },

  deleteWorktree: async (id) => {
    const existingTask = get().getTask(id);
    if (!existingTask?.worktreeId) {
      toast.error('This Worktree has no canonical identity and cannot be deleted safely.');
      return false;
    }
    const affectedProjectIds = Object.entries(get().tasksByProject)
      .filter(([, tasks]) => tasks.some((task) => task.id === id))
      .map(([projectId]) => projectId);
    const linkedSessionIds = existingTask?.sessions.map((session) => session.id) ?? [];

    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== id),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          tasks.filter((task) => task.id !== id),
        ]),
      ),
    }));
    if (linkedSessionIds.length > 0) {
      for (const sessionId of linkedSessionIds) {
        useSessionStore.getState().removeSession(sessionId);
      }
    }

    try {
      const res = await fetchWithClientId(`/api/worktrees/${existingTask.worktreeId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(body.error ?? 'Failed to delete Worktree');
        await useSessionStore.getState().loadProjects();
        await Promise.all(affectedProjectIds.map((projectId) => get().loadTasks(projectId, {
          setCurrent: get().currentProjectId === projectId,
        })));
        return false;
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete Worktree');
      await useSessionStore.getState().loadProjects();
      await Promise.all(affectedProjectIds.map((projectId) => get().loadTasks(projectId, {
        setCurrent: get().currentProjectId === projectId,
      })));
      return false;
    }
  },

  toggleTaskArchive: async (id, archived) => {
    const existingTask = get().getTask(id);
    if (!existingTask) return false;

    const affectedProjectIds = Object.entries(get().tasksByProject)
      .filter(([, tasks]) => tasks.some((task) => task.id === id))
      .map(([projectId]) => projectId);
    const linkedSessionIds = existingTask.sessions.map((session) => session.id);
    const archivedAt = archived ? new Date().toISOString() : undefined;

    const patchTasks = (tasks: TaskEntity[]) => archived
      ? tasks.filter((task) => task.id !== id)
      : tasks.map((task) => task.id === id ? { ...task, archived, archivedAt } : task);
    set((state) => ({
      tasks: patchTasks(state.tasks),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          patchTasks(tasks),
        ]),
      ),
    }));

    useSessionStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) =>
          linkedSessionIds.includes(session.id)
            ? { ...session, archived, archivedAt, isReadOnly: archived }
            : session
        ),
      })),
    }));

    try {
      const res = await fetchWithClientId(`/api/archive/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) throw new Error('Failed to update task archive state');
      if (archived) {
        for (const sessionId of linkedSessionIds) {
          useTabStore.getState().retireSessionSurface(sessionId);
        }
      }
      return true;
    } catch {
      await useSessionStore.getState().loadProjects();
      await Promise.all(affectedProjectIds.map((projectId) => get().loadTasks(projectId, {
        setCurrent: get().currentProjectId === projectId,
      })));
      return false;
    }
  },

  reorderTasks: (orderedIds, explicitProjectId) => {
    const projectId =
      explicitProjectId ??
      get().getTask(orderedIds[0])?.projectViewId ??
      get().currentProjectId;

    if (!projectId) return;

    const previousProjectTasks = get().getTasksForProject(projectId);
    if (previousProjectTasks.length === 0) return;

    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
    const nextProjectTasks = previousProjectTasks.map((task) =>
      orderMap.has(task.id) ? { ...task, sortOrder: orderMap.get(task.id)! } : task
    );

    set((state) => ({
      ...updateProjectCache(
        state,
        projectId,
        nextProjectTasks,
        state.currentProjectId === projectId
      ),
    }));

    fetchWithClientId('/api/tasks/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }).catch(() => {
      void get().loadTasks(projectId, { setCurrent: get().currentProjectId === projectId });
    });
  },

  getTask: (id) => {
    const currentTask = get().tasks.find((task) => task.id === id);
    if (currentTask) return currentTask;

    return Object.values(get().tasksByProject)
      .flat()
      .find((task) => task.id === id);
  },

  getTaskBySessionId: (sessionId) => {
    const currentTask = get().tasks.find((task) =>
      task.sessions.some((session) => session.id === sessionId)
    );
    if (currentTask) return currentTask;

    return Object.values(get().tasksByProject)
      .flat()
      .find((task) => task.sessions.some((session) => session.id === sessionId));
  },

  getTasksForProject: (projectId) => {
    const cachedProjectTasks = get().tasksByProject[projectId];
    if (cachedProjectTasks) return cachedProjectTasks;
    if (get().currentProjectId === projectId) return get().tasks;
    return [];
  },

  syncLinkedTaskTitle: (sessionId, title) =>
    set((state) => ({
      tasks: syncLinkedTaskTitleInList(state.tasks, sessionId, title),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          syncLinkedTaskTitleInList(tasks, sessionId, title),
        ])
      ),
    })),

  removeTaskSession: (sessionId) => {
    const state = get();
    const owner = state.tasks.find((task) => task.sessions.some((session) => session.id === sessionId))
      ?? Object.values(state.tasksByProject)
        .flat()
        .find((task) => task.sessions.some((session) => session.id === sessionId));
    if (!owner) return null;

    const index = owner.sessions.findIndex((session) => session.id === sessionId);
    const removed: RemovedTaskSession = {
      taskId: owner.id,
      index,
      session: owner.sessions[index],
    };

    set((current) => ({
      tasks: removeTaskSessionInList(current.tasks, sessionId),
      tasksByProject: Object.fromEntries(
        Object.entries(current.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          removeTaskSessionInList(tasks, sessionId),
        ])
      ),
    }));

    return removed;
  },

  restoreTaskSession: (removed) =>
    set((state) => ({
      tasks: restoreTaskSessionInList(state.tasks, removed),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          restoreTaskSessionInList(tasks, removed),
        ])
      ),
    })),

  replaceCollectionId: (fromCollectionId, toCollectionId) =>
    set((state) => ({
      tasks: replaceCollectionIdInList(state.tasks, fromCollectionId, toCollectionId),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          replaceCollectionIdInList(tasks, fromCollectionId, toCollectionId),
        ])
      ),
    })),

  clearTaskWorktrees: (taskIds) => {
    if (taskIds.length === 0) return;

    const targetTaskIds = new Set(taskIds);
    set((state) => ({
      tasks: clearTaskWorktreesInList(state.tasks, targetTaskIds),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [
          projectId,
          clearTaskWorktreesInList(tasks, targetTaskIds),
        ])
      ),
    }));
  },

  applyDiffStatsUpdate: (taskIds, diffStats) => {
    if (taskIds.length === 0) return;
    const targets = new Set(taskIds);
    const patch = (tasks: TaskEntity[]): TaskEntity[] => {
      let changed = false;
      const next = tasks.map((task) => {
        if (!targets.has(task.id)) return task;
        if (task.diffStats === diffStats) return task;
        changed = true;
        return { ...task, diffStats };
      });
      return changed ? next : tasks;
    };
    set((state) => ({
      tasks: patch(state.tasks),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [projectId, patch(tasks)]),
      ),
    }));
  },

  applyWorkflowStatusPromotions: (taskIds) => {
    if (taskIds.length === 0) return;
    const targets = new Set(taskIds);
    const patch = (tasks: TaskEntity[]): TaskEntity[] => {
      let changed = false;
      const next = tasks.map((task) => {
        if (!targets.has(task.id) || task.workflowStatus !== 'todo') return task;
        changed = true;
        return { ...task, workflowStatus: 'in_progress' as const };
      });
      return changed ? next : tasks;
    };

    set((state) => ({
      tasks: patch(state.tasks),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [projectId, patch(tasks)]),
      ),
    }));
  },

  applyPrStatusUpdate: (taskId, prStatus, prUnsupported, remoteBranchExists) => {
    const patch = (tasks: TaskEntity[]): TaskEntity[] => {
      let changed = false;
      const next = tasks.map((task) => {
        if (task.id !== taskId) return task;
        changed = true;
        return { ...task, prStatus, prUnsupported, remoteBranchExists };
      });
      return changed ? next : tasks;
    };
    set((state) => ({
      prStatusByTaskId: {
        ...state.prStatusByTaskId,
        [taskId]: { prStatus, prUnsupported, remoteBranchExists },
      },
      tasks: patch(state.tasks),
      tasksByProject: Object.fromEntries(
        Object.entries(state.tasksByProject).map(([projectId, tasks]) => [projectId, patch(tasks)]),
      ),
    }));
  },

  addPendingTask: (task) => {
    set((state) => {
      const projectTasks = [task, ...(state.tasksByProject[task.projectViewId] ?? [])];
      return {
        ...updateProjectCache(
          state,
          task.projectViewId,
          projectTasks,
          state.currentProjectId === task.projectViewId
        ),
      };
    });
  },

  removePendingTask: (tempId, projectId) => {
    set((state) => {
      const existing = state.tasksByProject[projectId] ?? [];
      const next = existing.filter((task) => task.id !== tempId);
      if (next.length === existing.length) return state;
      return {
        ...updateProjectCache(
          state,
          projectId,
          next,
          state.currentProjectId === projectId
        ),
      };
    });
  },

  finalizePendingTask: (tempId, realTask) => {
    set((state) => {
      // The placeholder may have been inserted under a different projectId key
      // than the one the server returns (e.g. encodedDir vs decodedPath), so
      // remove the placeholder from whichever bucket currently holds it.
      const nextByProject: Record<string, TaskEntity[]> = {};
      let placeholderWasInCurrent = false;
      for (const [pid, tasks] of Object.entries(state.tasksByProject)) {
        const idx = tasks.findIndex((task) => task.id === tempId);
        if (idx !== -1) {
          nextByProject[pid] = tasks.filter((task) => task.id !== tempId);
          if (pid === state.currentProjectId) placeholderWasInCurrent = true;
        } else {
          nextByProject[pid] = tasks;
        }
      }
      // Insert the real task into its server-reported project bucket.
      const targetBucket = nextByProject[realTask.projectViewId] ?? [];
      const withoutDupe = targetBucket.filter((task) => task.id !== realTask.id);
      nextByProject[realTask.projectViewId] = [realTask, ...withoutDupe];

      // Keep `tasks` (exposed to current-project subscribers) in sync.
      const nextTasks =
        state.currentProjectId && nextByProject[state.currentProjectId]
          ? nextByProject[state.currentProjectId]
          : placeholderWasInCurrent
            ? state.tasks.filter((task) => task.id !== tempId)
            : state.tasks;

      return {
        tasksByProject: nextByProject,
        tasks: nextTasks,
        loadedProjects: {
          ...state.loadedProjects,
          [realTask.projectViewId]: true,
        },
      };
    });
  },
}));
