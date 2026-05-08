import { create } from 'zustand';
import type { TaskEntity, WorkflowStatus } from '@/types/task-entity';
import { useSessionStore } from './session-store';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';

interface LoadTasksOptions {
  setCurrent?: boolean;
}

interface TaskPrStatusCacheEntry {
  prStatus: TaskEntity['prStatus'];
  prUnsupported: boolean;
  remoteBranchExists: boolean | undefined;
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
  /** Delete a task (optimistic) */
  deleteTask: (id: string) => Promise<{ deletedSessionCount: number } | null>;
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

  loadTasks: async (projectId, options) => {
    const shouldSetCurrent = options?.setCurrent !== false;
    if (get().loadingProjectIds[projectId]) return;

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
      set((state) => ({
        loadingProjectIds: removeProjectLoadingFlag(state, projectId),
      }));
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
        const projectTasks = [task, ...(state.tasksByProject[task.projectId] ?? [])];
        return {
          ...updateProjectCache(
            state,
            task.projectId,
            projectTasks,
            state.currentProjectId === task.projectId
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
    const projectId = existingTask?.projectId;
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

    if (projectId) {
      const previousProjectTasks = get().getTasksForProject(projectId);
      const nextProjectTasks = previousProjectTasks.map((task) =>
        task.id === id ? applyTaskPatch(task, patch) : task
      );

      set((state) => ({
        ...updateProjectCache(
          state,
          projectId,
          nextProjectTasks,
          state.currentProjectId === projectId
        ),
      }));
    }

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
        if (projectId)
          await get().loadTasks(projectId, { setCurrent: get().currentProjectId === projectId });
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
      if (projectId)
        await get().loadTasks(projectId, { setCurrent: get().currentProjectId === projectId });
      return false;
    }
  },

  deleteTask: async (id) => {
    const existingTask = get().getTask(id);
    const projectId = existingTask?.projectId;
    const linkedSessionIds = existingTask?.sessions.map((session) => session.id) ?? [];

    if (projectId) {
      const previousProjectTasks = get().getTasksForProject(projectId);
      const nextProjectTasks = previousProjectTasks.filter((task) => task.id !== id);

      set((state) => ({
        ...updateProjectCache(
          state,
          projectId,
          nextProjectTasks,
          state.currentProjectId === projectId
        ),
      }));
    }
    if (linkedSessionIds.length > 0) {
      for (const sessionId of linkedSessionIds) {
        useSessionStore.getState().removeSession(sessionId);
      }
    }

    try {
      const res = await fetchWithClientId(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        await useSessionStore.getState().loadProjects();
        if (projectId)
          await get().loadTasks(projectId, { setCurrent: get().currentProjectId === projectId });
        return null;
      }
      const data = await res.json();
      return { deletedSessionCount: data.deletedSessionCount ?? data.unlinkedCount ?? 0 };
    } catch {
      await useSessionStore.getState().loadProjects();
      if (projectId)
        await get().loadTasks(projectId, { setCurrent: get().currentProjectId === projectId });
      return null;
    }
  },

  toggleTaskArchive: async (id, archived) => {
    const existingTask = get().getTask(id);
    if (!existingTask) return false;

    if (archived) {
      for (const session of existingTask.sessions) {
        if (session.isRunning) {
          const { wsClient } = await import('@/lib/ws/client');
          wsClient.stopSession(session.id);
        }
      }
    }

    const projectId = existingTask.projectId;
    const previousProjectTasks = get().getTasksForProject(projectId);
    const linkedSessionIds = existingTask.sessions.map((session) => session.id);
    const archivedAt = archived ? new Date().toISOString() : undefined;

    set((state) => ({
      ...updateProjectCache(
        state,
        projectId,
        archived
          ? previousProjectTasks.filter((task) => task.id !== id)
          : previousProjectTasks.map((task) =>
              task.id === id ? { ...task, archived, archivedAt } : task
            ),
        state.currentProjectId === projectId
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
      return true;
    } catch {
      set((state) => ({
        ...updateProjectCache(
          state,
          projectId,
          previousProjectTasks,
          state.currentProjectId === projectId
        ),
      }));
      await useSessionStore.getState().loadProjects();
      return false;
    }
  },

  reorderTasks: (orderedIds, explicitProjectId) => {
    const projectId =
      explicitProjectId ??
      get().getTask(orderedIds[0])?.projectId ??
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
      const projectTasks = [task, ...(state.tasksByProject[task.projectId] ?? [])];
      return {
        ...updateProjectCache(
          state,
          task.projectId,
          projectTasks,
          state.currentProjectId === task.projectId
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
      const targetBucket = nextByProject[realTask.projectId] ?? [];
      const withoutDupe = targetBucket.filter((task) => task.id !== realTask.id);
      nextByProject[realTask.projectId] = [realTask, ...withoutDupe];

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
          [realTask.projectId]: true,
        },
      };
    });
  },
}));
