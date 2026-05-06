import { create } from 'zustand';
import type { SessionStatus, ProjectGroup, UnifiedSession } from '@/types/chat';
import { getSessionStatusGroup } from '@/types/task';
import { useChatStore } from './chat-store';
import { useTaskStore } from './task-store';
import { toast } from './notification-store';
import { wsClient } from '@/lib/ws/client';
import { captureTelemetryEvent } from '@/lib/telemetry/client';


interface SessionState {
  // Core state - NEW (project-grouped)
  projects: ProjectGroup[];
  activeSessionId: string | null;

  // REQ-002: Session creation loading state
  creatingSessionId: string | null;

  // REQ-003: Session loading indicator state
  loadingSessionId: string | null;

  // Actions - Project loading
  loadProjects: () => Promise<void>;
  loadMoreSessions: (encodedDir: string) => Promise<void>;
  loadMoreByStatusGroup: (encodedDir: string, statusGroup: string) => Promise<void>;

  // Actions - Session management
  setActiveSession: (sessionId: string | null) => void;
  addSession: (session: UnifiedSession) => void;
  removeSession: (sessionId: string) => void;
  upsertSession: (session: UnifiedSession) => void;
  removeProject: (encodedDir: string) => void;
  updateSessionTitle: (sessionId: string, title: string, hasCustomTitle?: boolean) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  markSessionReadOnly: (sessionId: string, isReadOnly: boolean) => void;
  markSessionRunning: (
    sessionId: string,
    tesseraSessionId: string,
    runtimeConfig?: Pick<UnifiedSession, 'model' | 'reasoningEffort'>,
  ) => void;
  markSessionStopped: (sessionId: string) => void;
  updateSessionRuntimeConfig: (
    sessionId: string,
    runtimeConfig: Partial<Pick<UnifiedSession, 'model' | 'reasoningEffort'>>,
  ) => void;
  setCreatingSession: (sessionId: string | null) => void;
  setLoadingSession: (sessionId: string | null) => void;
  getSession: (sessionId: string) => UnifiedSession | undefined;

  // Unread count actions (for FEAT-002)
  incrementUnreadCount: (sessionId: string) => void;
  clearUnreadCount: (sessionId: string) => void;
  // Task workflow actions (Unit 1 — Task Board Sidebar v2)
  updateLinkedTaskWorkflowStatus: (sessionId: string, workflowStatus: string) => void;
  syncTaskWorkflowStatus: (
    taskId: string,
    previousWorkflowStatus: NonNullable<UnifiedSession['workflowStatus']>,
    nextWorkflowStatus: NonNullable<UnifiedSession['workflowStatus']>,
    touchedSessionId?: string
  ) => void;
  applyWorkflowStatusPromotions: (taskIds: string[]) => void;
  updateSessionCollection: (sessionId: string, collectionId: string | null) => void;
  syncTaskCollectionId: (taskId: string, collectionId: string | null) => void;
  replaceCollectionId: (fromCollectionId: string, toCollectionId: string | null) => void;
  setTaskIdForSessions: (sessionIds: string[], taskId: string | null) => void;
  toggleArchive: (sessionId: string, archived: boolean) => void;
  moveSession: (sessionId: string, targetProjectId: string) => void;

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
  isGeneratingTitle: (sessionId: string) => boolean;

  /** Apply updated diff stats to every session whose id is in the set. */
  applyDiffStatsUpdate: (sessionIds: string[], diffStats: UnifiedSession['diffStats']) => void;

}

function mapApiSessionToUnified(s: any, fallbackProjectDir: string): UnifiedSession {
  return {
    id: s.id,
    title: s.title,
    projectDir: s.projectDir ?? fallbackProjectDir,
    isRunning: s.isRunning,
    status: s.status as SessionStatus,
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    tesseraSessionId: s.isRunning ? s.id : undefined,
    isReadOnly: s.isReadOnly ?? s.archived ?? false,
    hasCustomTitle: s.hasCustomTitle ?? false,
    workflowStatus: s.workflowStatus ?? undefined,
    worktreeBranch: s.worktreeBranch ?? undefined,
    workDir: s.workDir ?? undefined,
    archived: s.archived ?? false,
    archivedAt: s.archivedAt ?? undefined,
    worktreeDeletedAt: s.worktreeDeletedAt ?? undefined,
    sortOrder: s.sortOrder ?? 0,
    provider: s.provider,
    model: s.model ?? undefined,
    reasoningEffort: 'reasoningEffort' in s ? s.reasoningEffort : undefined,
    taskId: s.taskId ?? undefined,
    collectionId: s.collectionId ?? undefined,
    diffStats: s.diffStats ?? undefined,
  };
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

export const useSessionStore = create<SessionState>((set, get) => ({
  // Initial state
  projects: [],
  activeSessionId: null,
  creatingSessionId: null,
  loadingSessionId: null,

  // Project loading
  loadProjects: async () => {
    try {
      const res = await fetch('/api/sessions/projects');
      if (!res.ok) throw new Error('Failed to load projects');
      const data: { projects: any[] } = await res.json();

      const projects: ProjectGroup[] = data.projects.map((p) => {
        const sessions = p.sessions.map((s: any) => mapApiSessionToUnified(s, p.encodedDir));

        // Compute per-status cursors from the highest sort_order loaded per status
        const cursorByStatus: Record<string, string | null> = {};
        const countByStatus: Record<string, number> = p.countByStatus ?? {};
        for (const status of Object.keys(countByStatus)) {
          const statusSessions = sessions
            .filter((s: UnifiedSession) => getSessionStatusGroup(s) === status);
          if (statusSessions.length > 0) {
            const maxSortOrder = Math.max(...statusSessions.map((s: UnifiedSession) => s.sortOrder ?? 0));
            cursorByStatus[status] = String(maxSortOrder);
          } else {
            cursorByStatus[status] = null;
          }
        }

        return {
          encodedDir: p.encodedDir,
          displayName: p.displayName,
          decodedPath: p.decodedPath,
          displayPath: p.displayPath,
          isCurrent: p.isCurrent,
          sessions,
          totalSessions: p.totalSessions,
          allLoaded: sessions.length >= p.totalSessions,
          loadedCount: sessions.length,
          nextCursor: sessions.length > 0
            ? String(Math.max(...sessions.map((s: any) => s.sortOrder ?? 0)))
            : null,
          loadBatchIndex: 0,
          countByStatus,
          cursorByStatus,
        };
      });

      set({ projects });

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

      // Restore previously active session from sessionStorage, or auto-activate
      let autoActiveId: string | null = null;
      try {
        const savedId = sessionStorage.getItem('activeSessionId');
        // Verify saved session still exists in loaded projects
        if (savedId) {
          const exists = projects.some((p) =>
            p.sessions.some((s) => s.id === savedId)
          );
          if (exists) autoActiveId = savedId;
        }
      } catch {
        // Ignore storage errors
      }

      // Fallback: first running session or first session of current project
      if (!autoActiveId) {
        const currentProject = projects.find((p) => p.isCurrent);
        if (currentProject && currentProject.sessions.length > 0) {
          const runningSession = currentProject.sessions.find((s) => s.isRunning);
          autoActiveId = runningSession?.id || currentProject.sessions[0].id;
        } else if (projects.length > 0 && projects[0].sessions.length > 0) {
          autoActiveId = projects[0].sessions[0].id;
        }
      }

      if (autoActiveId && !get().activeSessionId) {
        get().setActiveSession(autoActiveId);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
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

      const res = await fetch(
        `/api/sessions/projects/${encodeURIComponent(encodedDir)}?limit=${limit}${cursorParam}`
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
            .map((s: any) => mapApiSessionToUnified(s, encodedDir));

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

      const res = await fetch(
        `/api/sessions/projects/${encodeURIComponent(encodedDir)}?limit=20&statusGroup=${statusGroup}${cursorParam}`
      );
      if (!res.ok) throw new Error('Failed to load more sessions');
      const data = await res.json();

      set((state) => ({
        projects: state.projects.map((p) => {
          if (p.encodedDir !== encodedDir) return p;

          const existingIds = new Set(p.sessions.map((s) => s.id));
          const newSessions = data.sessions
            .filter((s: any) => !existingIds.has(s.id))
            .map((s: any) => mapApiSessionToUnified(s, encodedDir));

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
    set({ activeSessionId: sessionId });
    // Persist to sessionStorage for restoration after page refresh
    try {
      if (sessionId !== null) {
        sessionStorage.setItem('activeSessionId', sessionId);
      } else {
        sessionStorage.removeItem('activeSessionId');
      }
    } catch {
      // Ignore storage errors (SSR, private browsing, etc.)
    }
  },

  addSession: (session: UnifiedSession) =>
    set((state) => {
      // Normalize projectDir — handle undefined from WebSocket messages missing workDir
      const projectDir = session.projectDir || 'unknown';
      // Apply defensive defaults for task metadata fields
      session = {
        ...session,
        projectDir,
        archived: session.archived ?? false,
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
        return {
          projects: [...state.projects, newProject],
          activeSessionId: session.id,
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

      return {
        projects: updatedProjects,
        activeSessionId: session.id,
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const updatedProjects = state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.filter((s) => s.id !== sessionId),
      }));

      // BR-DEL-006: 활성 세션 삭제 시 빈 상태 표시 (자동 전환 없음)
      // BR-DEL-007: 비활성 세션 삭제 시 현재 세션 유지
      let newActiveId = state.activeSessionId;
      if (state.activeSessionId === sessionId) {
        newActiveId = null; // 빈 상태 표시 (자동 전환 안 함)
      }

      // Clear activeSessionId from sessionStorage if it's the deleted session
      if (state.activeSessionId === sessionId) {
        try {
          sessionStorage.removeItem('activeSessionId');
        } catch {
          // Ignore storage errors
        }
      }

      return {
        projects: updatedProjects,
        activeSessionId: newActiveId,
      };
    }),

  upsertSession: (session) =>
    set((state) => {
      const projectDir = session.projectDir || 'unknown';
      const normalizedSession: UnifiedSession = {
        ...session,
        projectDir,
        archived: session.archived ?? false,
        isReadOnly: session.isReadOnly ?? session.archived ?? false,
        sortOrder: session.sortOrder ?? 0,
      };

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
          sessionStorage.removeItem('activeSessionId');
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
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                title,
                ...(hasCustomTitle !== undefined && { hasCustomTitle }),
              }
            : s
        ),
      })),
    })),

  updateSessionStatus: (sessionId, status) =>
    set((state) => ({
      projects: state.projects.map((project) => {
        const idx = project.sessions.findIndex((s) => s.id === sessionId);
        if (idx === -1) return project;

        const now = new Date().toISOString();
        const updatedSession = { ...project.sessions[idx], status, lastModified: now };

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
    })),

  markSessionReadOnly: (sessionId, isReadOnly) =>
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? { ...s, isReadOnly } : s
        ),
      })),
    })),

  markSessionRunning: (sessionId, tesseraSessionId, runtimeConfig) => {
    const providerId = get().getSession(sessionId)?.provider;
    if (providerId) {
      void captureTelemetryEvent('agent_session_started', {
        provider_id: providerId,
      });
    }

    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                isRunning: true,
                isReadOnly: false,
                status: 'running' as SessionStatus,
                tesseraSessionId,
                ...(runtimeConfig?.model !== undefined && { model: runtimeConfig.model }),
                ...(runtimeConfig?.reasoningEffort !== undefined && {
                  reasoningEffort: runtimeConfig.reasoningEffort,
                }),
              }
            : s
        ),
      })),
    }));
  },

  markSessionStopped: (sessionId) =>
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                isRunning: false,
                status: 'stopped' as SessionStatus,
                tesseraSessionId: undefined,
              }
            : s
        ),
      })),
    })),

  updateSessionRuntimeConfig: (sessionId, runtimeConfig) =>
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                ...(runtimeConfig.model !== undefined && { model: runtimeConfig.model }),
                ...(runtimeConfig.reasoningEffort !== undefined && {
                  reasoningEffort: runtimeConfig.reasoningEffort,
                }),
              }
            : s
        ),
      })),
    })),

  setCreatingSession: (sessionId) => set({ creatingSessionId: sessionId }),

  /**
   * Set the session ID currently loading messages.
   * Used to display loading indicator in the session item during message fetch.
   */
  setLoadingSession: (sessionId) => set({ loadingSessionId: sessionId }),

  getSession: (sessionId: string): UnifiedSession | undefined => {
    const { projects } = get();
    for (const project of projects) {
      const session = project.sessions.find((s) => s.id === sessionId);
      if (session) return session;
    }
    return undefined;
  },

  // Unread count actions
  incrementUnreadCount: (sessionId) =>
    set((state) => {
      if (state.activeSessionId === sessionId) {
        return state; // Don't increment for active session
      }

      return {
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, unreadCount: (s.unreadCount || 0) + 1 }
              : s
          ),
        })),
      };
    }),

  clearUnreadCount: (sessionId) =>
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? { ...s, unreadCount: 0 } : s
        ),
      })),
    })),

  // Task workflow actions
  updateLinkedTaskWorkflowStatus: (sessionId, workflowStatus) => {
    const session = get().getSession(sessionId);
    if (!session?.taskId || workflowStatus === 'chat') return;

    const nextWorkflowStatus = workflowStatus as NonNullable<UnifiedSession['workflowStatus']>;
    const previousWorkflowStatus = session.workflowStatus ?? 'todo';
    if (nextWorkflowStatus === previousWorkflowStatus) return;

    const taskId = session.taskId;
    get().syncTaskWorkflowStatus(taskId, previousWorkflowStatus, nextWorkflowStatus, sessionId);

    useTaskStore.getState().updateTask(taskId, { workflowStatus: nextWorkflowStatus as any }).then((ok) => {
      if (ok) return;

      get().syncTaskWorkflowStatus(taskId, nextWorkflowStatus, previousWorkflowStatus);
      console.warn(`[session-store] updateLinkedTaskWorkflowStatus rollback for task ${taskId}`);
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

  updateSessionCollection: (sessionId, collectionId) => {
    const session = get().getSession(sessionId);
    if (!session) return;

    if (session.taskId) {
      void useTaskStore.getState().updateTask(session.taskId, { collectionId });
      return;
    }

    const prev = session.collectionId;

    // Optimistic update
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId ? { ...s, collectionId: collectionId ?? undefined } : s
        ),
      })),
    }));

    // Server sync with rollback
    fetch(`/api/sessions/${sessionId}/collection`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectionId }),
    }).catch(() => {
      set((state) => ({
        projects: state.projects.map((project) => ({
          ...project,
          sessions: project.sessions.map((s) =>
            s.id === sessionId ? { ...s, collectionId: prev } : s
          ),
        })),
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
    }));
  },

  setTaskIdForSessions: (sessionIds, taskId) => {
    if (sessionIds.length === 0) return;

    const targetIds = new Set(sessionIds);
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) =>
          targetIds.has(session.id)
            ? { ...session, taskId: taskId ?? undefined }
            : session
        ),
      })),
    }));
  },

  toggleArchive: (sessionId, archived) => {
    const session = get().getSession(sessionId);

    // Auto-stop CLI process when archiving
    if (archived) {
      if (session?.isRunning) {
        wsClient.stopSession(sessionId);
      }
    }

    // Capture previous value for rollback
    const prevArchived = session?.archived;

    // Optimistic update
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                archived,
                archivedAt: archived ? new Date().toISOString() : undefined,
                isReadOnly: archived ? true : false,
              }
            : s
        ),
      })),
    }));

    fetch(`/api/sessions/${sessionId}/archive`, {
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

        if (result.cleanupError) {
          console.warn(`[session-store] archive cleanup warning for ${sessionId}: ${result.cleanupError}`);
        }
      })
      .catch(() => {
        // Rollback on any network or server error
        if (prevArchived !== undefined) {
          set((state) => ({
            projects: state.projects.map((project) => ({
              ...project,
              sessions: project.sessions.map((s) =>
                s.id === sessionId
                  ? { ...s, archived: prevArchived, isReadOnly: prevArchived ? true : false }
                  : s
              ),
            })),
          }));
          console.warn(`[session-store] toggleArchive rollback for session ${sessionId}`);
        }
      });
  },

  moveSession: (sessionId, targetProjectId) => {
    // Find session and source project for rollback
    const state = get();
    let session: UnifiedSession | undefined;
    let sourceProject: ProjectGroup | undefined;
    for (const p of state.projects) {
      const s = p.sessions.find((s) => s.id === sessionId);
      if (s) { session = s; sourceProject = p; break; }
    }
    if (!session || !sourceProject) return;

    const targetProject = state.projects.find(
      (p) => p.decodedPath === targetProjectId || p.encodedDir === targetProjectId
    );
    if (!targetProject || targetProject.encodedDir === sourceProject.encodedDir) return;

    const movedSession: UnifiedSession = {
      ...session,
      projectDir: targetProject.encodedDir,
      lastModified: new Date().toISOString(),
    };

    // Optimistic update: remove from source, add to target
    const sessionStatus = getSessionStatusGroup(session);
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.encodedDir === sourceProject!.encodedDir) {
          const counts = { ...p.countByStatus };
          if (sessionStatus && counts[sessionStatus] != null) {
            counts[sessionStatus] = Math.max(0, counts[sessionStatus] - 1);
          }
          return {
            ...p,
            sessions: p.sessions.filter((s) => s.id !== sessionId),
            totalSessions: Math.max(0, p.totalSessions - 1),
            loadedCount: Math.max(0, p.loadedCount - 1),
            countByStatus: counts,
          };
        }
        if (p.encodedDir === targetProject!.encodedDir) {
          const counts = { ...p.countByStatus };
          if (sessionStatus) {
            counts[sessionStatus] = (counts[sessionStatus] ?? 0) + 1;
          }
          return {
            ...p,
            sessions: [movedSession, ...p.sessions],
            totalSessions: p.totalSessions + 1,
            loadedCount: p.loadedCount + 1,
            countByStatus: counts,
          };
        }
        return p;
      }),
    }));

    // Server sync with rollback
    fetch(`/api/sessions/${sessionId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetProjectId }),
    }).then((res) => {
      if (!res.ok) throw new Error('Move failed');
    }).catch(() => {
      // Rollback: move session back to source
      set((state) => ({
        projects: state.projects.map((p) => {
          if (p.encodedDir === targetProject!.encodedDir) {
            const counts = { ...p.countByStatus };
            if (sessionStatus && counts[sessionStatus] != null) {
              counts[sessionStatus] = Math.max(0, counts[sessionStatus] - 1);
            }
            return {
              ...p,
              sessions: p.sessions.filter((s) => s.id !== sessionId),
              totalSessions: Math.max(0, p.totalSessions - 1),
              loadedCount: Math.max(0, p.loadedCount - 1),
              countByStatus: counts,
            };
          }
          if (p.encodedDir === sourceProject!.encodedDir) {
            const counts = { ...p.countByStatus };
            if (sessionStatus) {
              counts[sessionStatus] = (counts[sessionStatus] ?? 0) + 1;
            }
            return {
              ...p,
              sessions: [session!, ...p.sessions],
              totalSessions: p.totalSessions + 1,
              loadedCount: p.loadedCount + 1,
              countByStatus: counts,
            };
          }
          return p;
        }),
      }));
      console.warn(`[session-store] moveSession rollback for session ${sessionId}`);
      toast.error('Failed to move session');
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
    fetch('/api/sessions/projects/reorder', {
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
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.encodedDir !== projectDir) return p;
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
        return {
          ...p,
          sessions: p.sessions.map((s) =>
            orderMap.has(s.id)
              ? { ...s, sortOrder: orderMap.get(s.id)! }
              : s
          ),
        };
      }),
    }));

    // Persist to server
    fetch('/api/sessions/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectDir, orderedIds }),
    }).catch(() => {
      get().loadProjects();
    });
  },

  // Session reorder by IDs only (collection view)
  reorderSessionsByIds: (orderedIds) => {
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
    set((state) => ({
      projects: state.projects.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) =>
          orderMap.has(s.id)
            ? { ...s, sortOrder: orderMap.get(s.id)! }
            : s
        ),
      })),
    }));
    fetch('/api/sessions/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    }).catch(() => {
      get().loadProjects();
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
  isGeneratingTitle: (sessionId) => get().generatingTitleIds.has(sessionId),

  applyDiffStatsUpdate: (sessionIds, diffStats) => {
    if (sessionIds.length === 0) return;
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
        if (!projectChanged) return project;
        projectsChanged = true;
        return { ...project, sessions: nextSessions };
      });
      if (!projectsChanged) return state;
      return { projects: nextProjects };
    });
  },

}));
