import { create } from 'zustand';
import type { SessionStatus, ProjectGroup, UnifiedSession } from '@/types/chat';
import type { WorkflowStatus } from '@/types/task-entity';
import { getSessionStatusGroup } from '@/types/task';
import { useChatStore } from './chat-store';
import { useTaskStore } from './task-store';
import { useTabStore } from './tab-store';
import { retireProjectViewSessionSurfaces } from '@/lib/projects/project-view-open-surfaces';
import { toast } from './notification-store';
import { captureTelemetryEvent } from '@/lib/telemetry/client';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import {
  readUiStorageItem,
  removeUiStorageItem,
  writeUiStorageItem,
} from '@/lib/persistence/ui-storage';
import {
  findSessionProjectDir,
  LAST_ACTIVE_PROJECT_DIR_KEY,
  resolveLastActiveProjectDir,
} from '@/lib/session/last-active-project';
import {
  isBranchRenameWarningDismissed,
  persistBranchRenameWarningDismissal,
} from '@/lib/projects/branch-rename-warning';
import {
  applySessionRuntimeLiveness,
  beginSessionRuntimeConnection,
  createSessionRuntimeLiveness,
  forgetSessionRuntime,
  recordSessionRuntimeEvent,
  recordSessionRuntimeSnapshot,
  resolveSessionRuntimeLiveness,
  type SessionRuntimeLiveness,
} from '@/lib/session/session-runtime-liveness';
import { resolveStoredSessionAppearance } from '@/lib/projects/stored-session-resolution';
import { areCrossEnvironmentFilesystemPathsEquivalent } from '@/lib/filesystem/path-equivalence';

const ACTIVE_SESSION_STORAGE_KEY = 'tessera:active-session';

function readPersistedActiveSessionId(): string | null {
  const persisted = readUiStorageItem(ACTIVE_SESSION_STORAGE_KEY);
  if (persisted) return persisted;

  // Migrate the pre-Electron-bridge refresh key. sessionStorage does not
  // survive a native window restart, but an in-place browser upgrade can still
  // carry it long enough for us to move it into durable UI storage.
  try {
    const legacy = sessionStorage.getItem('activeSessionId');
    if (legacy) writeUiStorageItem(ACTIVE_SESSION_STORAGE_KEY, legacy);
    return legacy;
  } catch {
    return null;
  }
}

function findStoredSession(
  state: Pick<SessionState, 'projects' | 'retainedSessions'>,
  sessionId: string,
  projectDir?: string | null,
): UnifiedSession | undefined {
  return resolveStoredSessionAppearance(
    state.projects,
    state.retainedSessions,
    sessionId,
    projectDir,
  );
}


export interface SessionState {
  // Core state - NEW (project-grouped)
  projects: ProjectGroup[];
  /** Named creation-branch filters by Project View; missing means All branches. */
  projectCreationBranchFilters: Record<string, string>;
  activeSessionId: string | null;
  /** True after the first successful Project load attempts saved/fallback restoration. */
  didHydrateActiveSession: boolean;
  /** Project containing the most recently activated real conversation. */
  lastActiveProjectDir: string | null;
  runtimeLiveness: SessionRuntimeLiveness;
  /** Sessions hidden by projection but still needed by an open Project-local tab. */
  retainedSessions: Record<string, UnifiedSession>;

  // REQ-002: Session creation loading state
  creatingSessionId: string | null;

  // REQ-003: Session loading indicator state
  loadingSessionId: string | null;

  beginRuntimeConnection: () => void;

  // Actions - Project loading
  loadProjects: (options?: {
    restoredActiveSessionId?: string | null;
    restoredActiveTabId?: string;
  }) => Promise<void>;
  setProjectCreationBranchFilter: (projectId: string, branch?: string) => void;
  updateProjectWorktreeBranch: (worktreeId: string, branch: string | null) => void;
  dismissBranchRenameWarning: (projectId: string) => void;
  loadMoreSessions: (encodedDir: string) => Promise<void>;
  loadMoreByStatusGroup: (encodedDir: string, statusGroup: string) => Promise<void>;

  // Actions - Session management
  setActiveSession: (sessionId: string | null) => void;
  addSession: (session: UnifiedSession, options?: { activate?: boolean }) => void;
  removeSession: (sessionId: string) => void;
  /** Retain a navigable Session without inserting it into a direct Project Session page. */
  retainSession: (session: UnifiedSession) => void;
  upsertSession: (session: UnifiedSession) => void;
  removeProject: (encodedDir: string) => void;
  updateSessionTitle: (sessionId: string, title: string, hasCustomTitle?: boolean) => void;
  touchSessionActivity: (sessionId: string, touchedAt?: string) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  markSessionReadOnly: (sessionId: string, isReadOnly: boolean) => void;
  markSessionRunning: (
    sessionId: string,
    tesseraSessionId: string,
    runtimeConfig?: Pick<UnifiedSession, 'model' | 'reasoningEffort' | 'serviceTier' | 'fastMode' | 'sessionMode' | 'accessMode'>,
  ) => void;
  markSessionStopped: (sessionId: string) => void;
  /**
   * PTY 런타임 생존 상태를 가볍게 반영한다(사이드바 배지·Running 카운트가 읽는 필드).
   * markSessionRunning과 달리 telemetry 발화나
   * tesseraSessionId/runtimeConfig 덮어쓰기 같은 부수효과가 없다.
   */
  setSessionRunning: (sessionId: string, running: boolean) => void;
  applyGuiRuntimeSnapshot: (activeSessionIds: string[]) => void;
  applyTerminalRuntimeSnapshot: (activeSessionIds: string[]) => void;
  updateSessionRuntimeConfig: (
    sessionId: string,
    runtimeConfig: Partial<Pick<UnifiedSession, 'model' | 'reasoningEffort' | 'serviceTier' | 'fastMode' | 'sessionMode' | 'accessMode'>>,
  ) => void;
  setCreatingSession: (sessionId: string | null) => void;
  setLoadingSession: (sessionId: string | null) => void;

  // Unread count actions (for FEAT-002)
  incrementUnreadCount: (sessionId: string) => void;
  clearUnreadCount: (sessionId: string) => void;
  // Task workflow actions (Unit 1 — Task Board Sidebar v2)
  updateLinkedTaskWorkflowStatus: (
    sessionId: string,
    workflowStatus: string,
    projectViewId?: string,
  ) => void;
  updateChatWorkflowStatus: (
    sessionId: string,
    workflowStatus: WorkflowStatus | null,
    projectViewId?: string,
  ) => void;
  syncTaskWorkflowStatus: (
    taskId: string,
    previousWorkflowStatus: NonNullable<UnifiedSession['workflowStatus']>,
    nextWorkflowStatus: NonNullable<UnifiedSession['workflowStatus']>,
    touchedSessionId?: string
  ) => void;
  applyWorkflowStatusPromotions: (taskIds: string[]) => void;
  updateSessionCollection: (
    sessionId: string,
    collectionId: string | null,
    projectViewId?: string,
  ) => void;
  syncTaskCollectionId: (taskId: string, collectionId: string | null) => void;
  replaceCollectionId: (fromCollectionId: string, toCollectionId: string | null) => void;
  toggleArchive: (sessionId: string, archived: boolean) => Promise<boolean>;

  // Task selectors
  getSessionsByStatusGroup: (
    projectDir: string,
    statusGroup: string,
    excludeArchived?: boolean
  ) => UnifiedSession[];

  // Project strip reorder
  reorderProjects: (fromIndex: number, toIndex: number) => void;

  // Session reorder within a project-scoped sidebar grouping
  reorderProjectSessions: (projectDir: string, orderedIds: string[]) => void;

  // Session reorder by IDs only (collection view — no project/status scoping)
  reorderSessionsByIds: (orderedIds: string[]) => void;

  // AI title generation tracking
  generatingTitleIds: Set<string>;
  setGeneratingTitle: (sessionId: string, generating: boolean) => void;
  setGeneratingTitleIds: (sessionIds: readonly string[]) => void;
  isGeneratingTitle: (sessionId: string) => boolean;

  /**
   * Sessions with a background dynamic workflow currently executing. Drives the
   * "running/computing" indicators in the sidebar, tab/title and kanban so a
   * session looks active while its workflow runs — even after the main turn
   * ends. This is visual only; it never disables the composer.
   */
  runningWorkflowSessionIds: Set<string>;
  setSessionWorkflowRunning: (sessionId: string, running: boolean) => void;
  hasRunningWorkflow: (sessionId: string) => boolean;

  /** Apply updated diff stats to every session whose id is in the set. */
  applyDiffStatsUpdate: (
    sessionIds: string[],
    diffStats: UnifiedSession['diffStats'],
    workDir?: string,
  ) => void;

}

function mapApiSessionToUnified(
  s: any,
  viewProjectId: string,
  runtimeLiveness?: SessionRuntimeLiveness,
): UnifiedSession {
  const session: UnifiedSession = {
    id: s.id,
    title: s.title,
    projectDir: viewProjectId,
    originProjectId: s.originProjectId,
    isRunning: s.isRunning,
    status: s.status as SessionStatus,
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    tesseraSessionId: s.isRunning ? s.id : undefined,
    isReadOnly: s.isReadOnly ?? s.archived ?? false,
    hasCustomTitle: s.hasCustomTitle ?? false,
    workflowStatus: s.workflowStatus ?? undefined,
    worktreeBranch: s.worktreeBranch ?? undefined,
    worktreeId: s.worktreeId ?? undefined,
    scopeBranch: s.scopeBranch ?? undefined,
    kind: s.kind ?? undefined,
    workDir: s.workDir ?? undefined,
    archived: s.archived ?? false,
    archivedAt: s.archivedAt ?? undefined,
    worktreeDeletedAt: s.worktreeDeletedAt ?? undefined,
    sortOrder: s.sortOrder ?? 0,
    provider: s.provider,
    model: s.model ?? undefined,
    reasoningEffort: 'reasoningEffort' in s ? s.reasoningEffort : undefined,
    serviceTier: 'serviceTier' in s ? s.serviceTier : undefined,
    fastMode: 'fastMode' in s ? s.fastMode : undefined,
    hasStarted: s.hasStarted ?? s.isRunning ?? false,
    taskId: s.taskId ?? undefined,
    collectionId: s.collectionId ?? undefined,
    diffStats: s.diffStats ?? undefined,
  };
  return runtimeLiveness
    ? resolveSessionRuntimeLiveness(session, runtimeLiveness)
    : session;
}

function applyTaskWorkflowStatusToProjects(
  projects: ProjectGroup[],
  taskId: string,
  previousWorkflowStatus: NonNullable<UnifiedSession['workflowStatus']>,
  nextWorkflowStatus: NonNullable<UnifiedSession['workflowStatus']>,
  touchedSessionId?: string
): ProjectGroup[] {
  const touchedAt = touchedSessionId ? new Date().toISOString() : null;

  return projects.map((project) => {
    const affectedSessions = project.sessions.filter(
      (session) => session.taskId === taskId && !session.archived
    );
    if (affectedSessions.length === 0) {
      return project;
    }

    const updatedSessions = project.sessions.map((session) =>
      session.taskId === taskId
        ? {
            ...session,
            workflowStatus: nextWorkflowStatus,
            ...(touchedAt && session.id === touchedSessionId ? { lastModified: touchedAt } : {}),
          }
        : session
    );

    if (!project.countByStatus) {
      return { ...project, sessions: updatedSessions };
    }

    const counts = { ...project.countByStatus };
    if (counts[previousWorkflowStatus] != null) {
      counts[previousWorkflowStatus] = Math.max(0, counts[previousWorkflowStatus] - affectedSessions.length);
    }
    counts[nextWorkflowStatus] = (counts[nextWorkflowStatus] ?? 0) + affectedSessions.length;

    return { ...project, sessions: updatedSessions, countByStatus: counts };
  });
}

function applyChatWorkflowStatusToProjects(
  projects: ProjectGroup[],
  sessionId: string,
  previousStatusGroup: string,
  nextWorkflowStatus: WorkflowStatus | null,
): ProjectGroup[] {
  const nextStatusGroup = nextWorkflowStatus ?? 'chat';
  const touchedAt = new Date().toISOString();

  return projects.map((project) => {
    let hasAffectedSession = false;
    let isAffectedSessionArchived = false;
    const updatedSessions = project.sessions.map((session) => {
      if (session.id !== sessionId || session.taskId) {
        return session;
      }

      hasAffectedSession = true;
      isAffectedSessionArchived = session.archived;
      return {
        ...session,
        workflowStatus: nextWorkflowStatus ?? undefined,
        lastModified: touchedAt,
      };
    });

    if (!hasAffectedSession) {
      return project;
    }

    if (!project.countByStatus || isAffectedSessionArchived) {
      return { ...project, sessions: updatedSessions };
    }

    const counts = { ...project.countByStatus };
    if (counts[previousStatusGroup] != null) {
      counts[previousStatusGroup] = Math.max(0, counts[previousStatusGroup] - 1);
    }
    counts[nextStatusGroup] = (counts[nextStatusGroup] ?? 0) + 1;

    return { ...project, sessions: updatedSessions, countByStatus: counts };
  });
}

function applyTodoTaskPromotionsToProjects(
  projects: ProjectGroup[],
  taskIds: string[],
): ProjectGroup[] {
  if (taskIds.length === 0) return projects;
  const targets = new Set(taskIds);
  let projectsChanged = false;

  const nextProjects = projects.map((project) => {
    let affectedCount = 0;
    let projectChanged = false;
    const updatedSessions = project.sessions.map((session) => {
      if (
        session.archived ||
        !session.taskId ||
        !targets.has(session.taskId) ||
        (session.workflowStatus ?? 'todo') !== 'todo'
      ) {
        return session;
      }

      affectedCount += 1;
      projectChanged = true;
      return {
        ...session,
        workflowStatus: 'in_progress' as const,
      };
    });

    if (!projectChanged) return project;
    projectsChanged = true;

    if (!project.countByStatus) {
      return { ...project, sessions: updatedSessions };
    }

    const counts = { ...project.countByStatus };
    counts.todo = Math.max(0, (counts.todo ?? 0) - affectedCount);
    counts.in_progress = (counts.in_progress ?? 0) + affectedCount;

    return { ...project, sessions: updatedSessions, countByStatus: counts };
  });

  return projectsChanged ? nextProjects : projects;
}

function applyTaskCollectionIdToProjects(
  projects: ProjectGroup[],
  taskId: string,
  collectionId: string | null
): ProjectGroup[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.taskId === taskId
        ? { ...session, collectionId: collectionId ?? undefined }
        : session
    ),
  }));
}

function replaceCollectionIdInProjects(
  projects: ProjectGroup[],
  fromCollectionId: string,
  toCollectionId: string | null
): ProjectGroup[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.collectionId === fromCollectionId
        ? { ...session, collectionId: toCollectionId ?? undefined }
        : session
    ),
  }));
}

function mapRetainedSessions(
  retainedSessions: Record<string, UnifiedSession>,
  update: (session: UnifiedSession) => UnifiedSession,
): Record<string, UnifiedSession> {
  let next = retainedSessions;
  for (const [id, session] of Object.entries(retainedSessions)) {
    const updated = update(session);
    if (updated === session) continue;
    if (next === retainedSessions) next = { ...retainedSessions };
    next[id] = updated;
  }
  return next;
}

function updateRetainedSession(
  retainedSessions: Record<string, UnifiedSession>,
  sessionId: string,
  update: (session: UnifiedSession) => UnifiedSession,
): Record<string, UnifiedSession> {
  return mapRetainedSessions(
    retainedSessions,
    (session) => session.id === sessionId ? update(session) : session,
  );
}

let latestProjectLoadRequest = 0;

export const useSessionStore = create<SessionState>((set, get) => ({
  // Initial state
  projects: [],
  projectCreationBranchFilters: {},
  activeSessionId: null,
  didHydrateActiveSession: false,
  lastActiveProjectDir: null,
  runtimeLiveness: createSessionRuntimeLiveness(),
  retainedSessions: {},
  creatingSessionId: null,
  loadingSessionId: null,

  beginRuntimeConnection: () =>
    set({ runtimeLiveness: beginSessionRuntimeConnection() }),

  // Project loading
  loadProjects: async (options) => {
    const requestId = ++latestProjectLoadRequest;
    try {
      const creationBranchFilters = get().projectCreationBranchFilters;
      const filterQuery = Object.keys(creationBranchFilters).length > 0
        ? `?creationBranchFilters=${encodeURIComponent(JSON.stringify(creationBranchFilters))}`
        : '';
      const res = await fetch(`/api/sessions/projects${filterQuery}`);
      if (!res.ok) throw new Error('Failed to load projects');
      const data: { projects: any[] } = await res.json();
      // Keep Project-local open conversations addressable even when the live
      // projection hides them. The workspace boundary owns lifetime across
      // materialized panels, inactive Project snapshots, and Peek. Dynamic
      // import avoids the existing tab/panel/session store initialization cycle.
      const { projectViewWorkspaceState } = await import(
        '@/lib/projects/project-view-workspace-state-client'
      );
      const openSessionIds = new Set(projectViewWorkspaceState.getOpenSessionIds());

      const projects: ProjectGroup[] = data.projects.map((p) => {
        const sessions = p.sessions.map((s: any) => mapApiSessionToUnified(s, p.encodedDir));

        const countByStatus: Record<string, number> = p.countByStatus ?? {};
        const cursorByStatus: Record<string, string | null> = p.cursorByStatus ?? {};

        return {
          encodedDir: p.encodedDir,
          displayName: p.displayName,
          decodedPath: p.decodedPath,
          displayPath: p.displayPath,
          projectWorktree: p.projectWorktree,
          creationBranches: p.creationBranches ?? [],
          branchRenameWarning: p.branchRenameWarning
            && !isBranchRenameWarningDismissed(p.encodedDir, p.branchRenameWarning)
            ? p.branchRenameWarning
            : undefined,
          isCurrent: p.isCurrent,
          hasPreparationScript: p.hasPreparationScript,
          sessions,
          totalSessions: p.totalSessions,
          allLoaded: sessions.length >= p.totalSessions,
          loadedCount: sessions.length,
          nextCursor: p.nextCursor ?? null,
          loadBatchIndex: 0,
          countByStatus,
          cursorByStatus,
        };
      });

      if (requestId !== latestProjectLoadRequest) return;

      set((state) => {
        const nextProjects = applySessionRuntimeLiveness(projects, state.runtimeLiveness);
        const incomingSessionIds = new Set(
          nextProjects.flatMap((project) => project.sessions.map((session) => session.id)),
        );
        const previousSessions = [
          ...state.projects.flatMap((project) => project.sessions),
          ...Object.values(state.retainedSessions),
        ];
        const retainedSessions: Record<string, UnifiedSession> = {};
        for (const session of previousSessions) {
          if (openSessionIds.has(session.id) && !incomingSessionIds.has(session.id)) {
            retainedSessions[session.id] = session;
          }
        }
        return { projects: nextProjects, retainedSessions };
      });
      const loadedProjects = get().projects;
      const storedLastActiveProjectDir = readUiStorageItem(LAST_ACTIVE_PROJECT_DIR_KEY);
      const lastActiveProjectDir = resolveLastActiveProjectDir(
        loadedProjects,
        storedLastActiveProjectDir ?? get().lastActiveProjectDir,
      );
      set({ lastActiveProjectDir });

      // Initialize turn lifecycle state from server isGenerating state.
      const generatingSessionIds: string[] = [];
      for (const p of data.projects) {
        for (const s of p.sessions) {
          if (s.isGenerating) {
            generatingSessionIds.push(s.id);
          }
        }
      }
      if (generatingSessionIds.length > 0) {
        useChatStore.getState().setTurnsInFlight(generatingSessionIds);
      }

      if (!get().didHydrateActiveSession) {
        // Restore previously active session from sessionStorage, or auto-activate.
        // This is startup hydration, not a general Project reload behavior: after
        // it completes, null is a deliberate board-only selection that passive
        // mutation refreshes must preserve.
        let autoActiveId: string | null = null;
        const hasRestoredWorkspaceSelection = options
          && Object.prototype.hasOwnProperty.call(options, 'restoredActiveSessionId');
        if (hasRestoredWorkspaceSelection) {
          const restoredId = options.restoredActiveSessionId;
          if (restoredId && loadedProjects.some((project) =>
            project.sessions.some((session) => session.id === restoredId)
          )) {
            autoActiveId = restoredId;
          }
        } else {
          try {
            const savedId = readPersistedActiveSessionId();
            // Verify saved session still exists in loaded projects
            if (savedId) {
              const exists = loadedProjects.some((p) =>
                p.sessions.some((s) => s.id === savedId)
              );
              if (exists) autoActiveId = savedId;
            }
          } catch {
            // Ignore storage errors
          }
        }

        // Fallback only when there was no explicit restored tab selection.
        if (!autoActiveId && !hasRestoredWorkspaceSelection) {
          const lastActiveProject = loadedProjects.find(
            (project) => project.encodedDir === lastActiveProjectDir,
          );
          const currentProject = loadedProjects.find((project) => project.isCurrent);
          const fallbackProject = [lastActiveProject, currentProject, ...loadedProjects]
            .find((project) => project && project.sessions.length > 0);
          if (fallbackProject) {
            const runningSession = fallbackProject.sessions.find((session) => session.isRunning);
            autoActiveId = runningSession?.id ?? fallbackProject.sessions[0].id;
          }
        }

        if (hasRestoredWorkspaceSelection) {
          // Runtime startup events can temporarily select a background PTY.
          // The persisted active panel is authoritative for cold restoration,
          // including an intentionally empty tab.
          get().setActiveSession(autoActiveId);
        } else if (autoActiveId && !get().activeSessionId) {
          get().setActiveSession(autoActiveId);
        }
        if (options?.restoredActiveTabId) {
          const tabStore = useTabStore.getState();
          if (tabStore.tabs.some((tab) => tab.id === options.restoredActiveTabId)) {
            tabStore.setActiveTab(options.restoredActiveTabId);
          }
        }
        set({ didHydrateActiveSession: true });
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  },

  setProjectCreationBranchFilter: (projectId, branch) => {
    set((state) => {
      const projectCreationBranchFilters = { ...state.projectCreationBranchFilters };
      if (branch) projectCreationBranchFilters[projectId] = branch;
      else delete projectCreationBranchFilters[projectId];
      return { projectCreationBranchFilters };
    });
    void get().loadProjects();
    void useTaskStore.getState().loadTasks(projectId, { setCurrent: false });
  },

  updateProjectWorktreeBranch: (worktreeId, branch) => {
    const affectedProjectIds = get().projects
      .filter((project) => project.projectWorktree?.id === worktreeId)
      .map((project) => project.encodedDir);
    const changed = get().projects.some(
      (project) => project.projectWorktree?.id === worktreeId
        && project.projectWorktree.currentBranch !== branch,
    );
    set((state) => ({
      projects: state.projects.map((project) =>
        project.projectWorktree?.id === worktreeId
          ? {
              ...project,
              branchRenameWarning:
                project.projectWorktree.currentBranch === branch
                  ? project.branchRenameWarning
                  : undefined,
              projectWorktree: {
                ...project.projectWorktree,
                currentBranch: branch,
              },
            }
          : project,
      ),
    }));
    if (changed) {
      void get().loadProjects();
      void Promise.all(
        affectedProjectIds.map((projectId) => useTaskStore.getState().loadTasks(projectId, {
          setCurrent: useTaskStore.getState().currentProjectId === projectId,
        })),
      );
    }
  },

  dismissBranchRenameWarning: (projectId) => {
    const warning = get().projects.find(
      (project) => project.encodedDir === projectId,
    )?.branchRenameWarning;
    if (!warning) return;
    persistBranchRenameWarningDismissal(projectId, warning);
    set((state) => ({
      projects: state.projects.map((project) =>
        project.encodedDir === projectId
          ? { ...project, branchRenameWarning: undefined }
          : project,
      ),
    }));
  },

  loadMoreSessions: async (encodedDir: string) => {
    try {
      const project = get().projects.find((p) => p.encodedDir === encodedDir);
      if (!project || project.allLoaded) return;

      // Progressive batch sizes: 10 → 20 → 40 (capped)
      const LOAD_LIMITS = [10, 20, 40];
      const limit = LOAD_LIMITS[Math.min(project.loadBatchIndex, LOAD_LIMITS.length - 1)];
      // Use cursor when available, fall back to offset for backward compat
      const cursorParam = project.nextCursor
        ? `&cursor=${encodeURIComponent(project.nextCursor)}`
        : `&offset=${project.loadedCount}`;
      const creationBranch = get().projectCreationBranchFilters[encodedDir];
      const branchParam = creationBranch ? `&creationBranch=${encodeURIComponent(creationBranch)}` : '';

      const res = await fetch(
        `/api/sessions/projects/${encodeURIComponent(encodedDir)}?limit=${limit}${cursorParam}${branchParam}`
      );
      if (!res.ok) throw new Error('Failed to load more sessions');
      const data = await res.json();

      set((state) => ({
        projects: state.projects.map((p) => {
          if (p.encodedDir !== encodedDir) return p;

          // Dedup as safety net (cursor-based should avoid duplicates, but defense in depth)
          const existingIds = new Set(p.sessions.map((s) => s.id));
          const newSessions = data.sessions
            .filter((s: any) => !existingIds.has(s.id))
            .map((s: any) => mapApiSessionToUnified(s, encodedDir, state.runtimeLiveness));

          const allSessions = [...p.sessions, ...newSessions];
          // allLoaded: server says no more, OR no new sessions to display (all empty/dupes)
          const effectivelyDone = !data.hasMore || newSessions.length === 0;

          return {
            ...p,
            sessions: allSessions,
            loadedCount: p.loadedCount + data.sessions.length,
            totalSessions: data.totalSessions,
            allLoaded: effectivelyDone,
            nextCursor: data.nextCursor || null,
            loadBatchIndex: p.loadBatchIndex + 1,
          };
        }),
      }));
    } catch (err) {
      console.error('Failed to load more sessions:', err);
    }
  },

  loadMoreByStatusGroup: async (encodedDir: string, statusGroup: string) => {
    try {
      const project = get().projects.find((p) => p.encodedDir === encodedDir);
      if (!project) return;

      const cursor = project.cursorByStatus?.[statusGroup];
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const creationBranch = get().projectCreationBranchFilters[encodedDir];
      const branchParam = creationBranch ? `&creationBranch=${encodeURIComponent(creationBranch)}` : '';

      const res = await fetch(
        `/api/sessions/projects/${encodeURIComponent(encodedDir)}?limit=20&statusGroup=${statusGroup}${cursorParam}${branchParam}`
      );
      if (!res.ok) throw new Error('Failed to load more sessions');
      const data = await res.json();

      set((state) => ({
        projects: state.projects.map((p) => {
          if (p.encodedDir !== encodedDir) return p;

          const existingIds = new Set(p.sessions.map((s) => s.id));
          const newSessions = data.sessions
            .filter((s: any) => !existingIds.has(s.id))
            .map((s: any) => mapApiSessionToUnified(s, encodedDir, state.runtimeLiveness));

          return {
            ...p,
            sessions: [...p.sessions, ...newSessions],
            loadedCount: p.loadedCount + newSessions.length,
            cursorByStatus: {
              ...p.cursorByStatus,
              [statusGroup]: data.nextCursor || null,
            },
            countByStatus: {
              ...p.countByStatus,
              [statusGroup]: data.totalSessions,
            },
          };
        }),
      }));
    } catch (err) {
      console.error('Failed to load more sessions by status group:', err);
    }
  },

  // Session management
  setActiveSession: (sessionId) => {
    const state = get();
    const activatedProjectDir = findSessionProjectDir(state.projects, sessionId);
    set({
      activeSessionId: sessionId,
      lastActiveProjectDir: activatedProjectDir ?? state.lastActiveProjectDir,
    });
    // Persist outside the renderer origin so an Electron restart restores the
    // same focused Session even when Chromium's sessionStorage is gone.
    try {
      if (sessionId !== null) {
        writeUiStorageItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
      } else {
        removeUiStorageItem(ACTIVE_SESSION_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors (SSR, private browsing, etc.)
    }
    if (activatedProjectDir) {
      writeUiStorageItem(LAST_ACTIVE_PROJECT_DIR_KEY, activatedProjectDir);
    }
  },

  addSession: (session: UnifiedSession, options) => {
    let activatedProjectDir: string | null = null;
    set((state) => {
      const { projectDir } = session;
      // Apply defensive defaults for task metadata fields
      session = {
        ...session,
        projectDir,
        archived: session.archived ?? false,
        hasStarted: session.hasStarted ?? session.isRunning ?? false,
        sortOrder: session.sortOrder ?? 0,
      };

      // Find the project for this session (match by encodedDir OR decodedPath)
      let projectIndex = state.projects.findIndex(
        (p) => p.encodedDir === projectDir || p.decodedPath === projectDir
      );

      if (projectIndex === -1) {
        // Create new project if it doesn't exist
        const newProject: ProjectGroup = {
          encodedDir: projectDir,
          displayName: projectDir.split('/').pop() || 'Unknown',
          decodedPath: projectDir,
          isCurrent: false,
          sessions: [session],
          totalSessions: 1,
          allLoaded: false,
          loadedCount: 1,
          nextCursor: null,
          loadBatchIndex: 0,
        };
        if (options?.activate !== false) activatedProjectDir = newProject.encodedDir;
        return {
          projects: [...state.projects, newProject],
          activeSessionId: options?.activate === false ? state.activeSessionId : session.id,
          lastActiveProjectDir: options?.activate === false
            ? state.lastActiveProjectDir
            : newProject.encodedDir,
        };
      }

      // Update session's projectDir to match the project's encodedDir for consistency
      session = { ...session, projectDir: state.projects[projectIndex].encodedDir };

      // Add to existing project (at the top)
      const updatedProjects = [...state.projects];
      const project = { ...updatedProjects[projectIndex] };
      project.sessions = [session, ...project.sessions];
      project.totalSessions += 1;
      project.loadedCount += 1;
      updatedProjects[projectIndex] = project;
      if (options?.activate !== false) activatedProjectDir = project.encodedDir;

      return {
        projects: updatedProjects,
        activeSessionId: options?.activate === false ? state.activeSessionId : session.id,
        lastActiveProjectDir: options?.activate === false
          ? state.lastActiveProjectDir
          : project.encodedDir,
      };
    });
    if (activatedProjectDir) {
      writeUiStorageItem(LAST_ACTIVE_PROJECT_DIR_KEY, activatedProjectDir);
    }
  },

  removeSession: (sessionId) => {
    set((state) => {
      const updatedProjects = state.projects.map((project) => {
        const sessions = project.sessions.filter((session) => session.id !== sessionId);
        const removedCount = project.sessions.length - sessions.length;
        if (removedCount === 0) return project;
        return {
          ...project,
          sessions,
          totalSessions: Math.max(0, project.totalSessions - removedCount),
          loadedCount: Math.max(0, project.loadedCount - removedCount),
        };
      });

      // BR-DEL-006: 활성 세션 삭제 시 빈 상태 표시 (자동 전환 없음)
      // BR-DEL-007: 비활성 세션 삭제 시 현재 세션 유지
      let newActiveId = state.activeSessionId;
      if (state.activeSessionId === sessionId) {
        newActiveId = null; // 빈 상태 표시 (자동 전환 안 함)
      }

      // Clear the persisted focus if it points at the deleted Session.
      if (state.activeSessionId === sessionId) {
        try {
          removeUiStorageItem(ACTIVE_SESSION_STORAGE_KEY);
        } catch {
          // Ignore storage errors
        }
      }

      let runningWorkflowSessionIds = state.runningWorkflowSessionIds;
      if (runningWorkflowSessionIds.has(sessionId)) {
        runningWorkflowSessionIds = new Set(runningWorkflowSessionIds);
        runningWorkflowSessionIds.delete(sessionId);
      }

      const retainedSessions = { ...state.retainedSessions };
      delete retainedSessions[sessionId];

      return {
        projects: updatedProjects,
        retainedSessions,
        activeSessionId: newActiveId,
        runningWorkflowSessionIds,
        runtimeLiveness: forgetSessionRuntime(state.runtimeLiveness, sessionId),
      };
    });
    retireProjectViewSessionSurfaces(sessionId);
  },

  retainSession: (session) =>
    set((state) => {
      return {
        retainedSessions: {
          ...state.retainedSessions,
          [session.id]: {
            ...session,
            archived: session.archived ?? false,
            isReadOnly: session.isReadOnly ?? session.archived ?? false,
            hasStarted: session.hasStarted ?? session.isRunning ?? false,
            sortOrder: session.sortOrder ?? 0,
          },
        },
      };
    }),

  upsertSession: (session) =>
    set((state) => {
      const { projectDir } = session;
      const normalizedSession: UnifiedSession = {
        ...session,
        projectDir,
        archived: session.archived ?? false,
        isReadOnly: session.isReadOnly ?? session.archived ?? false,
        hasStarted: session.hasStarted ?? session.isRunning ?? false,
        sortOrder: session.sortOrder ?? 0,
      };

      if (state.retainedSessions[normalizedSession.id]) {
        return {
          retainedSessions: {
            ...state.retainedSessions,
            [normalizedSession.id]: {
              ...state.retainedSessions[normalizedSession.id],
              ...normalizedSession,
            },
          },
        };
      }

      let matchedProject = false;
      let matchedSession = false;
      const projects = state.projects.map((project) => {
        if (project.encodedDir !== projectDir && project.decodedPath !== projectDir) {
          return project;
        }

        matchedProject = true;
        const existingIndex = project.sessions.findIndex((s) => s.id === normalizedSession.id);
        if (existingIndex === -1) {
          return {
            ...project,
            sessions: [{ ...normalizedSession, projectDir: project.encodedDir }, ...project.sessions],
          };
        }

        matchedSession = true;
        return {
          ...project,
          sessions: project.sessions.map((existing) =>
            existing.id === normalizedSession.id
              ? { ...existing, ...normalizedSession, projectDir: project.encodedDir }
              : existing
          ),
        };
      });

      if (matchedProject || matchedSession) {
        return { projects };
      }

      return {
        projects: [
          ...projects,
          {
            encodedDir: projectDir,
            displayName: projectDir.split('/').pop() || 'Unknown',
            decodedPath: projectDir,
            isCurrent: false,
            sessions: [normalizedSession],
            totalSessions: 1,
            allLoaded: false,
            loadedCount: 1,
            nextCursor: null,
            loadBatchIndex: 0,
          },
        ],
      };
    }),

  removeProject: (encodedDir: string) =>
    set((state) => {
      const project = state.projects.find((p) => p.encodedDir === encodedDir);

      // If active session is in this project, clear active session
      let newActiveId = state.activeSessionId;
      if (project && project.sessions.some((s) => s.id === state.activeSessionId)) {
        newActiveId = null;
        try {
          removeUiStorageItem(ACTIVE_SESSION_STORAGE_KEY);
        } catch {
          // Ignore
        }
      }

      return {
        projects: state.projects.filter((p) => p.encodedDir !== encodedDir),
        activeSessionId: newActiveId,
      };
    }),

  updateSessionTitle: (sessionId, title, hasCustomTitle) =>
    set((state) => {
      const update = (session: UnifiedSession) => ({
        ...session,
        title,
        ...(hasCustomTitle !== undefined && { hasCustomTitle }),
      });
      return {
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((session) =>
            session.id === sessionId ? update(session) : session
          ),
        })),
        retainedSessions: updateRetainedSession(state.retainedSessions, sessionId, update),
      };
    }),

  touchSessionActivity: (sessionId, touchedAt) =>
    set((state) => {
      const nextTouchedAt = touchedAt ?? new Date().toISOString();
      const update = (session: UnifiedSession) => {
        if (session.lastModified && session.lastModified >= nextTouchedAt) return session;
        return { ...session, lastModified: nextTouchedAt };
      };
      return {
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((session) => {
            return session.id === sessionId ? update(session) : session;
          }),
        })),
        retainedSessions: updateRetainedSession(state.retainedSessions, sessionId, update),
      };
    }),

  updateSessionStatus: (sessionId, status) =>
    set((state) => {
      const now = new Date().toISOString();
      const update = (session: UnifiedSession) => ({
        ...session,
        status,
        lastModified: now,
        ...(status === 'running' && { hasStarted: true }),
      });
      return {
        projects: state.projects.map((project) => {
          const idx = project.sessions.findIndex((s) => s.id === sessionId);
          if (idx === -1) return project;

          const updatedSession = update(project.sessions[idx]);

          // Move to top when session becomes active (running)
          if (status === 'running' && idx > 0) {
            const sessions = [...project.sessions];
            sessions.splice(idx, 1);
            return { ...project, sessions: [updatedSession, ...sessions] };
          }

          return {
            ...project,
            sessions: project.sessions.map((s) =>
              s.id === sessionId ? updatedSession : s
            ),
          };
        }),
        retainedSessions: updateRetainedSession(state.retainedSessions, sessionId, update),
      };
    }),

  markSessionReadOnly: (sessionId, isReadOnly) =>
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? { ...s, isReadOnly } : s
        ),
      })),
      retainedSessions: updateRetainedSession(
        state.retainedSessions,
        sessionId,
        (session) => ({ ...session, isReadOnly }),
      ),
    })),

  markSessionRunning: (sessionId, tesseraSessionId, runtimeConfig) => {
    const providerId = findStoredSession(get(), sessionId)?.provider;
    if (providerId) {
      void captureTelemetryEvent('agent_session_started', {
        provider_id: providerId,
      });
    }

    const update = (session: UnifiedSession): UnifiedSession => ({
      ...session,
      isRunning: true,
      hasStarted: true,
      isReadOnly: false,
      status: 'running',
      tesseraSessionId,
      ...(runtimeConfig?.model !== undefined && { model: runtimeConfig.model }),
      ...(runtimeConfig?.reasoningEffort !== undefined && {
        reasoningEffort: runtimeConfig.reasoningEffort,
      }),
      ...(runtimeConfig?.serviceTier !== undefined && {
        serviceTier: runtimeConfig.serviceTier,
      }),
      ...(runtimeConfig?.fastMode !== undefined && { fastMode: runtimeConfig.fastMode }),
      ...(runtimeConfig?.sessionMode !== undefined && { sessionMode: runtimeConfig.sessionMode }),
      ...(runtimeConfig?.accessMode !== undefined && { accessMode: runtimeConfig.accessMode }),
    });
    set((state) => ({
      runtimeLiveness: recordSessionRuntimeEvent(
        state.runtimeLiveness,
        'gui',
        sessionId,
        true,
      ),
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? update(s) : s
        ),
      })),
      retainedSessions: updateRetainedSession(state.retainedSessions, sessionId, update),
    }));
  },

  markSessionStopped: (sessionId) =>
    set((state) => {
      let runningWorkflowSessionIds = state.runningWorkflowSessionIds;
      if (runningWorkflowSessionIds.has(sessionId)) {
        runningWorkflowSessionIds = new Set(runningWorkflowSessionIds);
        runningWorkflowSessionIds.delete(sessionId);
      }
      const update = (session: UnifiedSession): UnifiedSession => ({
        ...session,
        isRunning: false,
        status: 'stopped',
        tesseraSessionId: undefined,
      });
      return {
        runningWorkflowSessionIds,
        runtimeLiveness: recordSessionRuntimeEvent(
          state.runtimeLiveness,
          'gui',
          sessionId,
          false,
        ),
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((s) =>
            s.id === sessionId ? update(s) : s
          ),
        })),
        retainedSessions: updateRetainedSession(state.retainedSessions, sessionId, update),
      };
    }),

  setSessionRunning: (sessionId, running) =>
    set((state) => {
      // 값이 실제로 바뀔 때만 새 참조를 만들어 불필요한 리렌더를 막는다
      // hook replay에서 동일한 상태가 다시 와도 불필요한 리렌더를 하지 않는다.
      let changed = false;
      const projects = state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) => {
          if (s.id !== sessionId || s.isRunning === running) return s;
          changed = true;
          return {
            ...s,
            isRunning: running,
            hasStarted: running ? true : s.hasStarted,
            status: (running ? 'running' : 'stopped') as SessionStatus,
          };
        }),
      }));
      const runtimeLiveness = recordSessionRuntimeEvent(
        state.runtimeLiveness,
        'terminal',
        sessionId,
        running,
      );
      const retainedSessions = updateRetainedSession(
        state.retainedSessions,
        sessionId,
        (session) => session.isRunning === running
          ? session
          : {
              ...session,
              isRunning: running,
              hasStarted: running ? true : session.hasStarted,
              status: running ? 'running' : 'stopped',
            },
      );
      return changed || retainedSessions !== state.retainedSessions
        ? { projects, retainedSessions, runtimeLiveness }
        : { runtimeLiveness };
    }),

  applyGuiRuntimeSnapshot: (activeSessionIds) =>
    set((state) => {
      const runtimeLiveness = recordSessionRuntimeSnapshot(
        state.runtimeLiveness,
        'gui',
        activeSessionIds,
      );
      return {
        runtimeLiveness,
        projects: applySessionRuntimeLiveness(state.projects, runtimeLiveness),
        retainedSessions: mapRetainedSessions(
          state.retainedSessions,
          (session) => resolveSessionRuntimeLiveness(session, runtimeLiveness),
        ),
      };
    }),

  applyTerminalRuntimeSnapshot: (activeSessionIds) =>
    set((state) => {
      const runtimeLiveness = recordSessionRuntimeSnapshot(
        state.runtimeLiveness,
        'terminal',
        activeSessionIds,
      );
      return {
        runtimeLiveness,
        projects: applySessionRuntimeLiveness(state.projects, runtimeLiveness),
        retainedSessions: mapRetainedSessions(
          state.retainedSessions,
          (session) => resolveSessionRuntimeLiveness(session, runtimeLiveness),
        ),
      };
    }),

  updateSessionRuntimeConfig: (sessionId, runtimeConfig) =>
    set((state) => {
      const update = (session: UnifiedSession): UnifiedSession => ({
        ...session,
        ...(runtimeConfig.model !== undefined && { model: runtimeConfig.model }),
        ...(runtimeConfig.reasoningEffort !== undefined && {
          reasoningEffort: runtimeConfig.reasoningEffort,
        }),
        ...(runtimeConfig.serviceTier !== undefined && { serviceTier: runtimeConfig.serviceTier }),
        ...(runtimeConfig.fastMode !== undefined && { fastMode: runtimeConfig.fastMode }),
        ...(runtimeConfig.sessionMode !== undefined && { sessionMode: runtimeConfig.sessionMode }),
        ...(runtimeConfig.accessMode !== undefined && { accessMode: runtimeConfig.accessMode }),
      });
      return {
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((s) =>
            s.id === sessionId ? update(s) : s
          ),
        })),
        retainedSessions: updateRetainedSession(state.retainedSessions, sessionId, update),
      };
    }),

  setCreatingSession: (sessionId) => set({ creatingSessionId: sessionId }),

  /**
   * Set the session ID currently loading messages.
   * Used to display loading indicator in the session item during message fetch.
   */
  setLoadingSession: (sessionId) => set({ loadingSessionId: sessionId }),

  // Unread count actions
  incrementUnreadCount: (sessionId) => {
    const nextUnreadCount = (findStoredSession(get(), sessionId)?.unreadCount ?? 0) + 1;
    set((state) => ({
      // Notification handlers already decide whether the session is visibly
      // active. Re-checking the hidden tab's activeSessionId here breaks
      // full-board Peek after light-dismiss.
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId
            ? { ...s, unreadCount: (s.unreadCount || 0) + 1 }
            : s
        ),
      })),
      retainedSessions: updateRetainedSession(
        state.retainedSessions,
        sessionId,
        (session) => ({ ...session, unreadCount: (session.unreadCount || 0) + 1 }),
      ),
    }));
    useTaskStore.getState().setLinkedSessionUnreadCount(sessionId, nextUnreadCount);
  },

  clearUnreadCount: (sessionId) => {
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? { ...s, unreadCount: 0 } : s
        ),
      })),
      retainedSessions: updateRetainedSession(
        state.retainedSessions,
        sessionId,
        (session) => ({ ...session, unreadCount: 0 }),
      ),
    }));
    useTaskStore.getState().setLinkedSessionUnreadCount(sessionId, 0);
  },

  // Task workflow actions
  updateLinkedTaskWorkflowStatus: (sessionId, workflowStatus, projectViewId) => {
    const session = findStoredSession(get(), sessionId, projectViewId);
    if (!session?.taskId || workflowStatus === 'chat') return;

    const nextWorkflowStatus = workflowStatus as NonNullable<UnifiedSession['workflowStatus']>;
    if (nextWorkflowStatus === (session.workflowStatus ?? 'todo')) return;

    void useTaskStore.getState().updateTask(
      session.taskId,
      { workflowStatus: nextWorkflowStatus },
      projectViewId ?? session.projectDir,
    );
  },

  updateChatWorkflowStatus: (sessionId, workflowStatus, projectViewId) => {
    const session = findStoredSession(get(), sessionId, projectViewId);
    if (!session) return;

    if (session.taskId) {
      if (workflowStatus) {
        get().updateLinkedTaskWorkflowStatus(sessionId, workflowStatus, projectViewId);
      }
      return;
    }

    const previousWorkflowStatus = session.workflowStatus ?? null;
    if (previousWorkflowStatus === workflowStatus) return;

    const previousStatusGroup = getSessionStatusGroup(session);
    set((state) => ({
      projects: applyChatWorkflowStatusToProjects(
        state.projects,
        sessionId,
        previousStatusGroup,
        workflowStatus,
      ),
      retainedSessions: updateRetainedSession(
        state.retainedSessions,
        sessionId,
        (retained) => ({
          ...retained,
          workflowStatus: workflowStatus ?? undefined,
          lastModified: new Date().toISOString(),
        }),
      ),
    }));

    fetchWithClientId(`/api/sessions/${sessionId}/workflow-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowStatus }),
    }).then((response) => {
      if (!response.ok) {
        throw new Error('Failed to update chat workflow status');
      }
    }).catch(() => {
      set((state) => ({
        projects: applyChatWorkflowStatusToProjects(
          state.projects,
          sessionId,
          workflowStatus ?? 'chat',
          previousWorkflowStatus,
        ),
        retainedSessions: updateRetainedSession(
          state.retainedSessions,
          sessionId,
          (retained) => ({
            ...retained,
            workflowStatus: previousWorkflowStatus ?? undefined,
            lastModified: new Date().toISOString(),
          }),
        ),
      }));
      console.warn(`[session-store] updateChatWorkflowStatus rollback for session ${sessionId}`);
    });
  },

  syncTaskWorkflowStatus: (taskId, previousWorkflowStatus, nextWorkflowStatus, touchedSessionId) => {
    set((state) => ({
      projects: applyTaskWorkflowStatusToProjects(
        state.projects,
        taskId,
        previousWorkflowStatus,
        nextWorkflowStatus,
        touchedSessionId,
      ),
    }));
  },

  applyWorkflowStatusPromotions: (taskIds) => {
    if (taskIds.length === 0) return;
    set((state) => {
      const projects = applyTodoTaskPromotionsToProjects(state.projects, taskIds);
      return projects === state.projects ? state : { projects };
    });
  },

  updateSessionCollection: (sessionId, collectionId, projectViewId) => {
    const session = findStoredSession(get(), sessionId, projectViewId);
    if (!session) return;

    if (session.taskId) {
      void useTaskStore.getState().updateTask(
        session.taskId,
        { collectionId },
        projectViewId ?? session.projectDir,
      );
      return;
    }

    const targetProjectViewId = projectViewId ?? session.projectDir;
    const previousCollectionId = session.collectionId;

    // Optimistic update
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          project.encodedDir === targetProjectViewId && s.id === sessionId
            ? { ...s, collectionId: collectionId ?? undefined }
            : s
        ),
      })),
      retainedSessions: updateRetainedSession(
        state.retainedSessions,
        sessionId,
        (retained) => retained.projectDir === targetProjectViewId
          ? { ...retained, collectionId: collectionId ?? undefined }
          : retained,
      ),
    }));

    // Server sync with rollback
    fetchWithClientId(`/api/sessions/${sessionId}/collection`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectionId, projectViewId: targetProjectViewId }),
    }).catch(() => {
      set((state) => ({
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((candidate) =>
            project.encodedDir === targetProjectViewId && candidate.id === sessionId
              ? { ...candidate, collectionId: previousCollectionId }
              : candidate
          ),
        })),
        retainedSessions: updateRetainedSession(
          state.retainedSessions,
          sessionId,
          (retained) => retained.projectDir === targetProjectViewId
            ? { ...retained, collectionId: previousCollectionId }
            : retained,
        ),
      }));
    });
  },

  syncTaskCollectionId: (taskId, collectionId) => {
    set((state) => ({
      projects: applyTaskCollectionIdToProjects(state.projects, taskId, collectionId),
    }));
  },

  replaceCollectionId: (fromCollectionId, toCollectionId) => {
    set((state) => ({
      projects: replaceCollectionIdInProjects(state.projects, fromCollectionId, toCollectionId),
      retainedSessions: mapRetainedSessions(
        state.retainedSessions,
        (session) => session.collectionId === fromCollectionId
          ? { ...session, collectionId: toCollectionId ?? undefined }
          : session,
      ),
    }));
  },

  toggleArchive: (sessionId, archived) => {
    const session = findStoredSession(get(), sessionId);
    const archivedAt = archived ? new Date().toISOString() : undefined;
    const updateArchive = (target: UnifiedSession): UnifiedSession => ({
      ...target,
      archived,
      archivedAt,
      isReadOnly: archived,
    });

    // Capture previous value for rollback
    const prevArchived = session?.archived;
    const prevArchivedAt = session?.archivedAt;

    // A task-owned session archived on its own leaves its task's session list.
    // Held for rollback so a failed request puts the row back where it was.
    const removedTaskSession = archived
      ? useTaskStore.getState().removeTaskSession(sessionId)
      : null;

    // Optimistic update
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? updateArchive(s) : s
        ),
      })),
      retainedSessions: updateRetainedSession(
        state.retainedSessions,
        sessionId,
        updateArchive,
      ),
    }));

    return fetchWithClientId(`/api/sessions/${sessionId}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    })
      .then(async (response) => {
        const result = (typeof response.json === 'function'
          ? await response.json().catch(() => ({}))
          : {}) as {
          clearedSessionIds?: string[];
          clearedTaskIds?: string[];
          cleanupError?: string;
        };

        if (!response.ok) {
          throw new Error('Failed to update archive status');
        }

        if (archived) {
          retireProjectViewSessionSurfaces(sessionId);
        }

        if (result.cleanupError) {
          console.warn(`[session-store] archive cleanup warning for ${sessionId}: ${result.cleanupError}`);
        }
        return true;
      })
      .catch(() => {
        // Rollback on any network or server error
        if (removedTaskSession) {
          useTaskStore.getState().restoreTaskSession(removedTaskSession);
        }
        if (prevArchived !== undefined) {
          set((state) => ({
            projects: state.projects.map((project) => ({
              ...project,
              sessions: project.sessions.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      archived: prevArchived,
                      archivedAt: prevArchivedAt,
                      isReadOnly: prevArchived ? true : false,
                    }
                  : s
              ),
            })),
            retainedSessions: updateRetainedSession(
              state.retainedSessions,
              sessionId,
              (retained) => ({
                ...retained,
                archived: prevArchived,
                archivedAt: prevArchivedAt,
                isReadOnly: prevArchived,
              }),
            ),
          }));
          console.warn(`[session-store] toggleArchive rollback for session ${sessionId}`);
        }
        return false;
      });
  },

  getSessionsByStatusGroup: (projectDir, statusGroup, excludeArchived = true) => {
    const { projects } = get();
    const project = projects.find((p) => p.encodedDir === projectDir);
    if (!project) return [];
    return project.sessions
      .filter(
        (s) =>
          getSessionStatusGroup(s) === statusGroup &&
          (!excludeArchived || !s.archived)
      )
      .sort((a, b) => a.sortOrder - b.sortOrder);
  },

  // Project strip reorder (optimistic + server sync)
  reorderProjects: (fromIndex, toIndex) => {
    const projects = [...get().projects];
    const [moved] = projects.splice(fromIndex, 1);
    projects.splice(toIndex, 0, moved);
    set({ projects });

    // Persist to server
    const orderedIds = projects.map((p) => p.encodedDir);
    fetchWithClientId('/api/sessions/projects/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }).catch(() => {
      // Rollback on failure: reload from server
      get().loadProjects();
    });
  },

  // Session reorder within a project-scoped sidebar grouping (optimistic + server sync)
  reorderProjectSessions: (projectDir, orderedIds) => {
    // Optimistic update: rewrite sortOrder for matching sessions
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.encodedDir !== projectDir) return p;
        return {
          ...p,
          sessions: p.sessions.map((s) =>
            orderMap.has(s.id)
              ? { ...s, sortOrder: orderMap.get(s.id)! }
              : s
          ),
        };
      }),
      retainedSessions: mapRetainedSessions(
        state.retainedSessions,
        (session) => session.projectDir === projectDir && orderMap.has(session.id)
          ? { ...session, sortOrder: orderMap.get(session.id)! }
          : session,
      ),
    }));

    // Persist to server
    fetchWithClientId('/api/sessions/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }).catch(() => {
      get().loadProjects();
    });
  },

  // Session reorder by IDs only (collection view)
  reorderSessionsByIds: (orderedIds) => {
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
    const affectedTaskProjectIds = useTaskStore.getState().reorderLinkedSessions(orderedIds);
    set((state) => ({
      projects: state.projects.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) =>
          orderMap.has(s.id)
            ? { ...s, sortOrder: orderMap.get(s.id)! }
            : s
        ),
      })),
      retainedSessions: mapRetainedSessions(
        state.retainedSessions,
        (session) => orderMap.has(session.id)
          ? { ...session, sortOrder: orderMap.get(session.id)! }
          : session,
      ),
    }));
    void fetchWithClientId('/api/sessions/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }).then((response) => {
      if (!response.ok) throw new Error(`Session reorder failed: ${response.status}`);
    }).catch(() => {
      void Promise.all([
        get().loadProjects(),
        ...affectedTaskProjectIds.map((projectId) =>
          useTaskStore.getState().loadTasks(projectId, {
            setCurrent: useTaskStore.getState().currentProjectId === projectId,
          })
        ),
      ]);
    });
  },

  // AI title generation tracking
  generatingTitleIds: new Set<string>(),
  setGeneratingTitle: (sessionId, generating) => {
    set((state) => {
      const next = new Set(state.generatingTitleIds);
      if (generating) next.add(sessionId);
      else next.delete(sessionId);
      return { generatingTitleIds: next };
    });
  },
  setGeneratingTitleIds: (sessionIds) => {
    set({ generatingTitleIds: new Set(sessionIds) });
  },
  isGeneratingTitle: (sessionId) => get().generatingTitleIds.has(sessionId),

  // Background workflow execution tracking
  runningWorkflowSessionIds: new Set<string>(),
  setSessionWorkflowRunning: (sessionId, running) => {
    set((state) => {
      if (running === state.runningWorkflowSessionIds.has(sessionId)) return state;
      const next = new Set(state.runningWorkflowSessionIds);
      if (running) next.add(sessionId);
      else next.delete(sessionId);
      return { runningWorkflowSessionIds: next };
    });
  },
  hasRunningWorkflow: (sessionId) => get().runningWorkflowSessionIds.has(sessionId),

  applyDiffStatsUpdate: (sessionIds, diffStats, workDir) => {
    if (sessionIds.length === 0 && !workDir) return;
    const targets = new Set(sessionIds);
    set((state) => {
      let projectsChanged = false;
      const nextProjects = state.projects.map((project) => {
        let projectChanged = false;
        const nextSessions = project.sessions.map((session) => {
          if (!targets.has(session.id)) return session;
          if (session.diffStats === diffStats) return session;
          projectChanged = true;
          return { ...session, diffStats };
        });
        const projectWorktree = project.projectWorktree;
        const isProjectWorktreeTarget = Boolean(
          workDir
          && projectWorktree
          && areCrossEnvironmentFilesystemPathsEquivalent(projectWorktree.path, workDir),
        );
        const nextProjectWorktree = isProjectWorktreeTarget
          && projectWorktree
          && projectWorktree.diffStats !== diffStats
          ? { ...projectWorktree, diffStats }
          : projectWorktree;
        // A Project Worktree owns all direct chat badges. Legacy Sessions may
        // spell the same checkout as /home/... while the canonical server path
        // is UNC, so a root update must not depend on per-Session path equality.
        const projectWorktreeChanged = nextProjectWorktree !== projectWorktree;
        const projectSessions = isProjectWorktreeTarget
          ? nextSessions.map((session) => session.taskId || session.diffStats === diffStats
            ? session
            : { ...session, diffStats })
          : nextSessions;
        if (projectWorktreeChanged || projectSessions !== nextSessions) projectChanged = true;
        if (!projectChanged) return project;
        projectsChanged = true;
        return { ...project, sessions: projectSessions, projectWorktree: nextProjectWorktree };
      });
      const retainedSessions = mapRetainedSessions(
        state.retainedSessions,
        (session) => targets.has(session.id) && session.diffStats !== diffStats
          ? { ...session, diffStats }
          : session,
      );
      if (!projectsChanged && retainedSessions === state.retainedSessions) return state;
      return { projects: nextProjects, retainedSessions };
    });
  },

}));

/** True when the given session has a background workflow currently executing. */
export const selectHasRunningWorkflow = (sessionId: string) =>
  (state: SessionState): boolean => state.runningWorkflowSessionIds.has(sessionId);

/** True when any of the given sessions has a background workflow executing. */
export const selectAnyRunningWorkflow = (sessionIds: readonly string[]) =>
  (state: SessionState): boolean =>
    sessionIds.some((id) => state.runningWorkflowSessionIds.has(id));
