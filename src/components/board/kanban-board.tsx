'use client';

import { memo, useCallback, useState, useEffect, useId, useMemo, useRef } from 'react';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useTaskStore } from '@/stores/task-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getProviderSessionRuntimeConfig } from '@/lib/settings/provider-defaults';
import { captureTelemetryEvent } from '@/lib/telemetry/client';
import { useSessionCrud } from '@/hooks/use-session-crud';
import {
  useSessionClickHandlers,
  tryForwardClickToMainWindow,
} from '@/hooks/use-session-click-handlers';
import { setKanbanChatDragData } from '@/lib/dnd/panel-session-drag';
import { WORKFLOW_STATUS_ORDER } from '@/types/task-entity';
import type { WorkflowStatus, TaskEntity } from '@/types/task-entity';
import { TASK_DND_MIME } from '@/types/task';
import type { UnifiedSession } from '@/types/chat';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';
import { CollectionFilterBar } from './collection-filter-bar';
import { KanbanChatColumn, KanbanWorkflowColumn } from './kanban-column';
import { KanbanScrollControls } from './kanban-scroll-controls';
import { TaskContextMenu } from '@/components/chat/task-context-menu';
import { DeleteSessionDialog } from '@/components/chat/delete-session-dialog';
import { DeleteTaskDialog } from '@/components/chat/delete-task-dialog';
import { MoveProjectDialog } from '@/components/chat/move-project-dialog';
import { wsClient } from '@/lib/ws/client';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import {
  getKanbanScrollPosition,
  getKanbanScrollPositionKey,
  saveKanbanScrollPosition,
} from '@/lib/kanban-scroll-position';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import type { Collection } from '@/types/collection';

/**
 * KanbanBoard -- collection-based kanban with Chat column + Workflow columns.
 *
 * Layout:
 *   [Filter bar: All | collection1 | collection2 | ...]
 *   [Todo] [Doing] [Review] [Done] | [Chat col]
 *
 * - Chat column: sessions that have no taskId (pure chat sessions)
 * - Workflow columns: tasks grouped by workflowStatus
 * - Collection filter: narrows both chat and task items by collectionId
 */
const EMPTY_COLLECTIONS: Collection[] = [];
const SCROLL_ANCHOR_EPSILON = 1;
const SCROLL_END_SNAP_THRESHOLD = 16;
const RESIZE_SCROLL_SUPPRESSION_MS = 500;

interface ScrollSnapshot {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}

export const KanbanBoard = memo(function KanbanBoard() {
  const scrollAreaId = useId();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef<ScrollSnapshot>({
    clientWidth: 0,
    scrollLeft: 0,
    scrollWidth: 0,
  });
  const anchorRightEdgeRef = useRef<number | null>(null);
  const anchorAtRightEndRef = useRef(false);
  const suppressScrollAnchorUpdateRef = useRef(false);
  const hasRestoredScrollPositionRef = useRef(false);
  const scrollPositionKeyRef = useRef<string>('');

  // Board store
  const selectedProjectDir = useBoardStore((s) => s.selectedProjectDir);
  const activeCollectionFilter = useBoardStore((s) => s.activeCollectionFilter);
  const setCollectionFilter = useBoardStore((s) => s.setCollectionFilter);
  const kanbanAddMenuColumn = useBoardStore((s) => s.kanbanAddMenuColumn);

  // Collection store
  const collections = useCollectionStore((s) =>
    selectedProjectDir ? s.collectionsByProject[selectedProjectDir] ?? EMPTY_COLLECTIONS : EMPTY_COLLECTIONS
  );
  const collectionsLoadedForProject = useCollectionStore((s) =>
    selectedProjectDir ? Boolean(s.loadedProjects[selectedProjectDir]) : false
  );

  // Task store
  const tasks = useTaskStore((s) => s.tasks);
  // Session store
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const selectionSessionId = getSessionSelectionId(activeSessionId);
  const projects = useSessionStore((s) => s.projects);
  const scrollPositionKey = getKanbanScrollPositionKey(selectedProjectDir, activeCollectionFilter);

  useEffect(function keepKanbanViewportAnchoredOnResize() {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    let trailingScrollFrame: number | null = null;
    let trailingResizeFrame: number | null = null;
    let resizeSuppressTimeout: ReturnType<typeof setTimeout> | null = null;

    const captureScrollPosition = (updateAnchor: boolean) => {
      if (updateAnchor) {
        if (scrollArea.scrollLeft > SCROLL_ANCHOR_EPSILON) {
          const rightEdge = scrollArea.scrollLeft + scrollArea.clientWidth;
          anchorAtRightEndRef.current =
            scrollArea.scrollWidth - rightEdge <= SCROLL_END_SNAP_THRESHOLD;
          anchorRightEdgeRef.current = anchorAtRightEndRef.current
            ? scrollArea.scrollWidth
            : rightEdge;
        } else {
          anchorAtRightEndRef.current = false;
          anchorRightEdgeRef.current = null;
        }
      }

      scrollSnapshotRef.current = {
        clientWidth: scrollArea.clientWidth,
        scrollLeft: scrollArea.scrollLeft,
        scrollWidth: scrollArea.scrollWidth,
      };
      if (scrollPositionKeyRef.current && hasRestoredScrollPositionRef.current) {
        saveKanbanScrollPosition(scrollPositionKeyRef.current, scrollArea.scrollLeft);
      }
    };

    const rememberScrollPosition = () => {
      captureScrollPosition(!suppressScrollAnchorUpdateRef.current);
      if (trailingScrollFrame !== null) {
        cancelAnimationFrame(trailingScrollFrame);
      }
      trailingScrollFrame = requestAnimationFrame(() => {
        trailingScrollFrame = null;
        captureScrollPosition(!suppressScrollAnchorUpdateRef.current);
      });
    };

    rememberScrollPosition();
    scrollArea.addEventListener('scroll', rememberScrollPosition, { passive: true });

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (trailingScrollFrame !== null) {
          cancelAnimationFrame(trailingScrollFrame);
        }
        if (trailingResizeFrame !== null) {
          cancelAnimationFrame(trailingResizeFrame);
        }
        if (resizeSuppressTimeout !== null) {
          clearTimeout(resizeSuppressTimeout);
        }
        scrollArea.removeEventListener('scroll', rememberScrollPosition);
      };
    }

    const suppressAnchorUpdatesDuringResize = () => {
      suppressScrollAnchorUpdateRef.current = true;
      if (resizeSuppressTimeout !== null) {
        clearTimeout(resizeSuppressTimeout);
      }
      resizeSuppressTimeout = setTimeout(() => {
        suppressScrollAnchorUpdateRef.current = false;
        resizeSuppressTimeout = null;
      }, RESIZE_SCROLL_SUPPRESSION_MS);
    };

    const applyRightEdgeAnchor = (anchorRightEdge: number) => {
      const currentClientWidth = scrollArea.clientWidth;
      const currentScrollWidth = scrollArea.scrollWidth;
      const maxScrollLeft = Math.max(0, currentScrollWidth - currentClientWidth);
      suppressAnchorUpdatesDuringResize();
      scrollArea.scrollLeft = Math.max(
        0,
        Math.min(maxScrollLeft, anchorRightEdge - currentClientWidth),
      );
      scrollSnapshotRef.current = {
        clientWidth: currentClientWidth,
        scrollLeft: scrollArea.scrollLeft,
        scrollWidth: currentScrollWidth,
      };
    };

    const resizeObserver = new ResizeObserver(() => {
      const previous = scrollSnapshotRef.current;
      const nextClientWidth = scrollArea.clientWidth;
      const nextScrollWidth = scrollArea.scrollWidth;
      const measuredRightEdge =
        scrollArea.scrollLeft > SCROLL_ANCHOR_EPSILON
          ? scrollArea.scrollLeft + previous.clientWidth
          : null;
      const previousScrollWidth = previous.scrollWidth || nextScrollWidth;
      if (
        measuredRightEdge !== null &&
        previousScrollWidth - measuredRightEdge <= SCROLL_END_SNAP_THRESHOLD
      ) {
        anchorAtRightEndRef.current = true;
      }
      let anchorRightEdge =
        anchorAtRightEndRef.current
          ? previousScrollWidth
          : anchorRightEdgeRef.current === null
          ? measuredRightEdge
          : measuredRightEdge === null
            ? anchorRightEdgeRef.current
            : Math.max(anchorRightEdgeRef.current, measuredRightEdge);
      if (
        anchorRightEdge !== null &&
        previousScrollWidth - anchorRightEdge <= SCROLL_END_SNAP_THRESHOLD
      ) {
        anchorRightEdge = previousScrollWidth;
      }

      if (
        previous.clientWidth > 0 &&
        anchorRightEdge !== null &&
        Math.abs(previous.clientWidth - nextClientWidth) > SCROLL_ANCHOR_EPSILON
      ) {
        anchorRightEdgeRef.current = anchorRightEdge;
        applyRightEdgeAnchor(anchorRightEdge);
        if (trailingResizeFrame !== null) {
          cancelAnimationFrame(trailingResizeFrame);
        }
        trailingResizeFrame = requestAnimationFrame(() => {
          trailingResizeFrame = null;
          applyRightEdgeAnchor(anchorRightEdge);
        });
      }

      scrollSnapshotRef.current = {
        clientWidth: nextClientWidth,
        scrollLeft: scrollArea.scrollLeft,
        scrollWidth: nextScrollWidth,
      };
    });

    resizeObserver.observe(scrollArea);

    return () => {
      if (trailingScrollFrame !== null) {
        cancelAnimationFrame(trailingScrollFrame);
      }
      if (trailingResizeFrame !== null) {
        cancelAnimationFrame(trailingResizeFrame);
      }
      if (resizeSuppressTimeout !== null) {
        clearTimeout(resizeSuppressTimeout);
      }
      resizeObserver.disconnect();
      scrollArea.removeEventListener('scroll', rememberScrollPosition);
    };
  }, []);

  useEffect(function restoreKanbanScrollPosition() {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    hasRestoredScrollPositionRef.current = false;
    scrollPositionKeyRef.current = scrollPositionKey;

    const savedScrollLeft = getKanbanScrollPosition(scrollPositionKey);
    const restoreFrame = requestAnimationFrame(() => {
      const maxScrollLeft = Math.max(0, scrollArea.scrollWidth - scrollArea.clientWidth);
      scrollArea.scrollLeft = Math.max(0, Math.min(maxScrollLeft, savedScrollLeft));
      scrollSnapshotRef.current = {
        clientWidth: scrollArea.clientWidth,
        scrollLeft: scrollArea.scrollLeft,
        scrollWidth: scrollArea.scrollWidth,
      };
      hasRestoredScrollPositionRef.current = true;
      saveKanbanScrollPosition(scrollPositionKey, scrollArea.scrollLeft);
    });

    return () => {
      cancelAnimationFrame(restoreFrame);
    };
  }, [scrollPositionKey]);

  // Load collections on mount
  useEffect(() => {
    if (!selectedProjectDir) return;
    void useCollectionStore.getState().loadCollections(selectedProjectDir);
  }, [selectedProjectDir]);

  // Load tasks when project changes
  useEffect(() => {
    if (selectedProjectDir) {
      useTaskStore.getState().loadTasks(selectedProjectDir);
    }
  }, [selectedProjectDir]);

  // Session CRUD
  const { deleteSession, generateTitle, renameSession } = useSessionCrud();

  // Get all sessions for the selected project
  const allSessions = useMemo(() => {
    const project = projects.find((p) => p.encodedDir === selectedProjectDir);
    return project?.sessions ?? [];
  }, [projects, selectedProjectDir]);

  // Chat sessions: sessions with no taskId, not archived
  const chatSessions = useMemo(() => {
    return allSessions.filter((s) => !s.taskId && !s.archived);
  }, [allSessions]);

  // Apply collection filter
  const filteredChats = useMemo(() => {
    const baseChats = activeCollectionFilter
      ? chatSessions.filter((s) => s.collectionId === activeCollectionFilter)
      : chatSessions;
    return baseChats.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  }, [chatSessions, activeCollectionFilter]);

  const visibleTaskSessions = useMemo(() => {
    return allSessions.filter((s) => s.taskId && !s.archived);
  }, [allSessions]);

  const filteredTasks = useMemo(() => {
    const visibleTaskSessionIds = new Set(visibleTaskSessions.map((s) => s.id));
    const baseTasks = tasks.filter((task) =>
      task.sessions.some((session) => visibleTaskSessionIds.has(session.id))
    );
    if (!activeCollectionFilter) return baseTasks;
    return baseTasks.filter((t) => t.collectionId === activeCollectionFilter);
  }, [tasks, activeCollectionFilter, visibleTaskSessions]);

  useEffect(() => {
    if (!activeCollectionFilter) return;
    // Don't clear the filter while collections are still loading -- otherwise a
    // popout opened with a hydrated filter would see an empty collection list
    // and reset itself before loadCollections() resolves.
    if (!collectionsLoadedForProject) return;
    if (collections.some((collection) => collection.id === activeCollectionFilter)) return;
    setCollectionFilter(null);
  }, [activeCollectionFilter, collections, collectionsLoadedForProject, setCollectionFilter]);

  const selectedProject = useMemo(() => {
    return projects.find((project) => project.encodedDir === selectedProjectDir) ?? null;
  }, [projects, selectedProjectDir]);

  const activeCollection = useMemo(() => {
    if (!activeCollectionFilter) return null;
    return collections.find((collection) => collection.id === activeCollectionFilter) ?? null;
  }, [activeCollectionFilter, collections]);

  // Group tasks by workflow status
  const tasksByStatus = useMemo(() => {
    const map: Record<WorkflowStatus, TaskEntity[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const task of filteredTasks) {
      const status = task.workflowStatus;
      if (map[status]) {
        map[status].push(task);
      }
    }
    for (const status of WORKFLOW_STATUS_ORDER) {
      map[status].sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return map;
  }, [filteredTasks]);

  // Build a map of taskId -> sessions for expansion
  const sessionsByTaskId = useMemo(() => {
    const map: Record<string, UnifiedSession[]> = {};
    for (const s of visibleTaskSessions) {
      if (s.taskId) {
        if (!map[s.taskId]) map[s.taskId] = [];
        map[s.taskId].push(s);
      }
    }
    return map;
  }, [visibleTaskSessions]);

  const mergedTasksByStatus = useMemo(() => {
    const liveSessions = Object.values(sessionsByTaskId).flat();
    const map: Record<WorkflowStatus, TaskEntity[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };

    for (const status of WORKFLOW_STATUS_ORDER) {
      map[status] = mergeTasksWithLiveSessions(tasksByStatus[status], liveSessions);
    }

    return map;
  }, [sessionsByTaskId, tasksByStatus]);

  // Compute ordered IDs for Shift+Click range select
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    // Match the rendered board order exactly so Shift+Click range selection
    // uses the same primary session IDs and intra-task session ordering.
    for (const status of WORKFLOW_STATUS_ORDER) {
      for (const task of mergedTasksByStatus[status]) {
        const sessions = task.sessions;
        for (const s of sessions) {
          ids.push(s.id);
        }
      }
    }
    for (const s of filteredChats) {
      ids.push(s.id);
    }
    return ids;
  }, [filteredChats, mergedTasksByStatus]);

  // Click handlers
  const { handleSessionClick, handleSessionDoubleClick } = useSessionClickHandlers({ orderedIds });

  const handleChatDragStart = useCallback((sessionId: string, e: React.DragEvent) => {
    setKanbanChatDragData(e.dataTransfer, sessionId);
    requestAnimationFrame(() => {
      useBoardStore.getState().setDragging(sessionId);
    });
  }, []);

  const handleChatDragEnd = useCallback((_e: React.DragEvent) => {
    useBoardStore.getState().setDragging(null);
    useBoardStore.getState().setDragOver(null);
    useBoardStore.getState().setDropIndicator(null);
  }, []);

  const handleChatSessionDragOver = useCallback((sessionId: string, status: string, e: React.DragEvent) => {
    if (status !== 'chat' || !e.dataTransfer.types.includes(TASK_DND_MIME)) return;

    const draggingSessionId = useBoardStore.getState().draggingTaskId;
    if (!draggingSessionId || draggingSessionId === sessionId) {
      if (useBoardStore.getState().dropIndicator) {
        useBoardStore.getState().setDropIndicator(null);
      }
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';
    const current = useBoardStore.getState().dropIndicator;

    if (current?.targetSessionId !== sessionId || current.position !== position) {
      useBoardStore.getState().setDropIndicator({ targetSessionId: sessionId, position });
    }
  }, []);

  const handleChatColumnDragOver = useCallback((status: string, e: React.DragEvent) => {
    if (status !== 'chat' || !e.dataTransfer.types.includes(TASK_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (useBoardStore.getState().dragOverStatus !== 'chat') {
      useBoardStore.getState().setDragOver('chat');
    }
  }, []);

  const handleChatColumnDragLeave = useCallback((status: string, e: React.DragEvent) => {
    if (status !== 'chat') return;
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    if (useBoardStore.getState().dragOverStatus === 'chat') {
      useBoardStore.getState().setDragOver(null);
    }
    useBoardStore.getState().setDropIndicator(null);
  }, []);

  const handleChatColumnDrop = useCallback((status: string, e: React.DragEvent) => {
    e.preventDefault();
    if (status !== 'chat' || !e.dataTransfer.types.includes(TASK_DND_MIME)) return;

    const sessionId = e.dataTransfer.getData(TASK_DND_MIME);
    const indicator = useBoardStore.getState().dropIndicator;

    if (selectedProjectDir && sessionId) {
      const ids = filteredChats.map((session) => session.id);
      const filtered = ids.filter((id) => id !== sessionId);

      if (indicator) {
        const targetIdx = filtered.indexOf(indicator.targetSessionId);
        if (targetIdx !== -1) {
          const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
          filtered.splice(insertIdx, 0, sessionId);
        }
      } else {
        filtered.push(sessionId);
      }

      useSessionStore.getState().reorderProjectSessions(selectedProjectDir, filtered);
      useBoardStore.getState().flashDrop(sessionId);
    }

    useBoardStore.getState().setDragging(null);
    useBoardStore.getState().setDragOver(null);
    useBoardStore.getState().setDropIndicator(null);
  }, [filteredChats, selectedProjectDir]);

  // Kanban add card menu toggle
  const handleToggleAddMenu = useCallback(function handleToggleAddMenu() {
    const store = useBoardStore.getState();
    store.setKanbanAddMenuColumn(store.kanbanAddMenuColumn === 'chat' ? null : 'chat');
  }, []);

  const handleCloseAddMenu = useCallback(() => {
    useBoardStore.getState().setKanbanAddMenuColumn(null);
  }, []);

  const [quickCreateStatus, setQuickCreateStatus] = useState<WorkflowStatus | null>(null);

  const handleCreateTaskInStatus = useCallback((status: WorkflowStatus) => {
    useBoardStore.getState().setKanbanAddMenuColumn(null);
    setQuickCreateStatus((current) => (current === status ? null : status));
  }, []);

  // Context menu handlers for kanban chat cards
  const handleCardStatusChange = useCallback((taskId: string, status: string) => {
    useSessionStore.getState().updateLinkedTaskWorkflowStatus(taskId, status);
  }, []);

  const handleCardArchive = useCallback((taskId: string) => {
    useSessionStore.getState().toggleArchive(taskId, true);
  }, []);

  const handleCardUnarchive = useCallback((taskId: string) => {
    useSessionStore.getState().toggleArchive(taskId, false);
  }, []);

  // Delete session dialog
  const [sessionToDelete, setSessionToDelete] = useState<UnifiedSession | null>(null);
  const [taskToDelete, setTaskToDelete] = useState<TaskEntity | null>(null);
  const handleCardDelete = useCallback((taskId: string) => {
    const session = useSessionStore.getState().getSession(taskId);
    if (session) setSessionToDelete(session);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!sessionToDelete) return;
    await deleteSession(sessionToDelete.id);
    setSessionToDelete(null);
  }, [sessionToDelete, deleteSession]);

  const handleConfirmTaskDelete = useCallback(async () => {
    if (!taskToDelete) return;
    await useTaskStore.getState().deleteTask(taskToDelete.id);
    setTaskToDelete(null);
  }, [taskToDelete]);

  const handleCardRename = useCallback(async (sessionId: string, newTitle: string) => {
    await renameSession(sessionId, newTitle);
  }, [renameSession]);

  const handleCardOpenInNewTab = useCallback(async (taskId: string) => {
    if (tryForwardClickToMainWindow(taskId, 'pin')) return;
    useTabStore.getState().createTabWithSession(taskId);
  }, []);

  const handleCardGenerateTitle = useCallback(async (taskId: string) => {
    await generateTitle(taskId);
  }, [generateTitle]);

  // Move to project dialog
  const [moveSessionTarget, setMoveSessionTarget] = useState<UnifiedSession | null>(null);
  const handleCardMoveToProject = useCallback((taskId: string) => {
    const session = useSessionStore.getState().getSession(taskId);
    if (session) setMoveSessionTarget(session);
  }, []);

  const handleMoveConfirm = useCallback((targetProjectId: string) => {
    if (!moveSessionTarget) return;
    useSessionStore.getState().moveSession(moveSessionTarget.id, targetProjectId);
    setMoveSessionTarget(null);
  }, [moveSessionTarget]);

  const handleCardStopProcess = useCallback((taskId: string) => {
    wsClient.stopSession(taskId);
    useSessionStore.getState().clearUnreadCount(taskId);
    wsClient.sendMarkAsRead(taskId);
  }, []);

  // Card click handler
  const handleChatClick = useCallback((session: UnifiedSession, event?: React.MouseEvent) => {
    handleSessionClick(session, event);
  }, [handleSessionClick]);

  const handleChatDoubleClick = useCallback((session: UnifiedSession) => {
    handleSessionDoubleClick(session);
  }, [handleSessionDoubleClick]);

  // ── Add session to existing task (matching list view's addSessionToTask) ──

  const handleAddSessionToTask = useCallback(async (task: TaskEntity, requestedProviderId?: string) => {
    try {
      // If active panel already has a session, create a new tab
      const panelState = usePanelStore.getState();
      const tabData = selectActiveTab(panelState);
      const activePanel = tabData?.panels[tabData.activePanelId ?? ''];
      if (activePanel?.sessionId != null) {
        useTabStore.getState().createTab();
      }

      const settings = useSettingsStore.getState().settings;
      const providerId = requestedProviderId?.trim() || task.sessions[0]?.provider?.trim();
      if (!providerId) {
        throw new Error('Cannot add a session to this task because it has no provider');
      }
      const runtimeConfig = getProviderSessionRuntimeConfig(settings, providerId);

      const res = await fetchWithClientId('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workDir: task.workDir || undefined,
          parentProjectId: task.projectId,
          taskId: task.id,
          collectionId: task.collectionId || undefined,
          worktreeBranch: task.worktreeBranch || undefined,
          ...runtimeConfig,
          providerId,
        }),
      });
      if (!res.ok) throw new Error('Failed to create session');
      const data = await res.json();
      const newSessionId = data.sessionId || data.id;
      if (!newSessionId) throw new Error('No session ID returned');

      // Add session to store and open in panel
      const newSession: UnifiedSession = {
        id: newSessionId,
        title: data.title || 'New Session',
        projectDir: task.projectId || '',
        isRunning: true,
        status: 'running',
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        archived: false,
        sortOrder: 0,
        worktreeBranch: task.worktreeBranch,
        taskId: task.id,
        collectionId: task.collectionId,
        provider: data.provider,
        model: data.model,
        reasoningEffort: data.reasoningEffort,
        serviceTier: data.serviceTier,
      };

      useSessionStore.getState().addSession(newSession);
      useChatStore.getState().loadHistory(newSessionId, []);

      // Assign to active panel
      {
        const ps = usePanelStore.getState();
        ps.assignSession(
          selectActiveTab(ps)?.activePanelId ?? '',
          newSessionId,
        );
        useTabStore.getState().syncTabProjectFromSession(ps.activeTabId, newSessionId);
      }

      // Refresh task store and session store
      await useTaskStore.getState().loadTasks(task.projectId);
      await useSessionStore.getState().loadProjects();

      void captureTelemetryEvent('session_created', {
        provider_id: data.provider || providerId,
        has_task: true,
        has_worktree: Boolean(task.worktreeBranch),
      });
    } catch (err) {
      console.error('Failed to add session to task:', err);
    }
  }, []);

  // ── Task context menu state ──

  const [taskMenuAnchor, setTaskMenuAnchor] = useState<{ task: TaskEntity; rect: DOMRect } | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);

  const handleTaskContextMenu = useCallback((task: TaskEntity, anchorRect: DOMRect) => {
    setTaskMenuAnchor({ task, rect: anchorRect });
  }, []);

  const handleTaskMenuClose = useCallback(() => {
    setTaskMenuAnchor(null);
  }, []);

  // Task context menu action handlers
  const handleTaskStatusChange = useCallback((status: string) => {
    if (!taskMenuAnchor) return;
    useTaskStore.getState().updateTask(taskMenuAnchor.task.id, { workflowStatus: status as WorkflowStatus });
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  const handleTaskDelete = useCallback(() => {
    if (!taskMenuAnchor) return;
    setTaskToDelete(taskMenuAnchor.task);
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  const handleTaskArchive = useCallback(() => {
    if (!taskMenuAnchor) return;
    void useTaskStore.getState().toggleTaskArchive(taskMenuAnchor.task.id, true);
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  const handleTaskGenerateTitle = useCallback(async () => {
    if (!taskMenuAnchor) return;
    const primarySession = taskMenuAnchor.task.sessions[0];
    if (primarySession) {
      await generateTitle(primarySession.id);
    }
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor, generateTitle]);

  const handleTaskOpenInNewTab = useCallback(() => {
    if (!taskMenuAnchor) return;
    const primarySession = taskMenuAnchor.task.sessions[0];
    if (primarySession) {
      if (!tryForwardClickToMainWindow(primarySession.id, 'pin')) {
        useTabStore.getState().createTabWithSession(primarySession.id);
      }
    }
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  const handleTaskStopProcess = useCallback(() => {
    if (!taskMenuAnchor) return;
    for (const s of taskMenuAnchor.task.sessions) {
      if (s.isRunning) {
        wsClient.stopSession(s.id);
        useSessionStore.getState().clearUnreadCount(s.id);
        wsClient.sendMarkAsRead(s.id);
      }
    }
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  const handleChatMoveToCollection = useCallback((sessionId: string, collectionId: string | null) => {
    useSessionStore.getState().updateSessionCollection(sessionId, collectionId);
  }, []);

  const handleTaskMoveToCollection = useCallback((collectionId: string | null) => {
    if (!taskMenuAnchor) return;
    void useTaskStore.getState().updateTask(taskMenuAnchor.task.id, { collectionId });
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  const taskMenuIsRunning = taskMenuAnchor?.task.sessions.some((s) => s.isRunning) ?? false;
  const handleTaskRename = useCallback(async (taskId: string, newTitle: string) => {
    await useTaskStore.getState().updateTask(taskId, { title: newTitle });
  }, []);

  const handleTaskRenameComplete = useCallback((taskId: string) => {
    setRenamingTaskId((current) => (current === taskId ? null : current));
  }, []);

  const handleTaskRenameStart = useCallback(() => {
    if (!taskMenuAnchor) return;
    setRenamingTaskId(taskMenuAnchor.task.id);
    setTaskMenuAnchor(null);
  }, [taskMenuAnchor]);

  return (
    <div
      className="flex flex-col h-full w-full bg-(--board-bg) overflow-hidden"
      data-testid="kanban-board"
    >
      {/* Collection filter bar */}
      <CollectionFilterBar
        collections={collections}
        activeFilter={activeCollectionFilter}
        onFilter={setCollectionFilter}
      />

      {/* Horizontal scroll container */}
      <div
        id={scrollAreaId}
        ref={scrollAreaRef}
        className="flex-1 overflow-x-auto overflow-y-hidden scrollbar-none"
        data-kanban-scroll-area="true"
        data-testid="kanban-scroll-area"
      >
        <div
          className="inline-flex gap-3 h-full px-4 py-4 min-w-max"
          data-testid="kanban-columns-row"
        >
          {/* Workflow columns */}
          {WORKFLOW_STATUS_ORDER.map((status) => (
            <KanbanWorkflowColumn
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
              sessionsByTaskId={sessionsByTaskId}
              activeSessionId={selectionSessionId}
              onCreateTask={() => handleCreateTaskInStatus(status)}
              isQuickCreateOpen={quickCreateStatus === status}
              quickCreateConfig={selectedProject ? {
                collection: activeCollection,
                collections,
                projectDir: selectedProject.decodedPath,
                projectId: selectedProject.encodedDir,
                allowCollectionSelection: activeCollection === null,
                onClose: () => setQuickCreateStatus(null),
              } : undefined}
              onSessionClick={handleChatClick}
              onSessionDoubleClick={handleChatDoubleClick}
              onAddSession={handleAddSessionToTask}
              onTaskContextMenu={handleTaskContextMenu}
              onTaskRename={handleTaskRename}
              onSessionRename={handleCardRename}
              onSessionDelete={handleCardDelete}
              onSessionOpenInNewTab={handleCardOpenInNewTab}
              onSessionGenerateTitle={handleCardGenerateTitle}
              onSessionMoveToProject={handleCardMoveToProject}
              onSessionStopProcess={handleCardStopProcess}
              renamingTaskId={renamingTaskId}
              onTaskRenameComplete={handleTaskRenameComplete}
            />
          ))}

          {/* Divider */}
          <div className="w-px bg-(--divider) mx-2 self-stretch opacity-50 shrink-0" />

          {/* Chat column */}
          <KanbanChatColumn
            chats={filteredChats}
            collection={activeCollection}
            collections={collections}
            projectId={selectedProject?.encodedDir ?? ''}
            projectDir={selectedProject?.decodedPath ?? ''}
            activeSessionId={selectionSessionId}
            isAddMenuOpen={kanbanAddMenuColumn === 'chat'}
            onCardDragStart={handleChatDragStart}
            onCardDragEnd={handleChatDragEnd}
            onCardDragOver={handleChatSessionDragOver}
            onColumnDragOver={handleChatColumnDragOver}
            onColumnDragLeave={handleChatColumnDragLeave}
            onColumnDrop={handleChatColumnDrop}
            onCardClick={handleChatClick}
            onCardDoubleClick={handleChatDoubleClick}
            onToggleAddMenu={handleToggleAddMenu}
            onCloseAddMenu={handleCloseAddMenu}
            onCardStatusChange={handleCardStatusChange}
            onCardArchive={handleCardArchive}
            onCardUnarchive={handleCardUnarchive}
            onCardRename={handleCardRename}
            onCardDelete={handleCardDelete}
            onCardOpenInNewTab={handleCardOpenInNewTab}
            onCardGenerateTitle={handleCardGenerateTitle}
            onCardMoveToProject={handleCardMoveToProject}
            onCardMoveToCollection={handleChatMoveToCollection}
            onCardStopProcess={handleCardStopProcess}
          />
        </div>
      </div>

      <KanbanScrollControls scrollAreaId={scrollAreaId} scrollAreaRef={scrollAreaRef} />

      {/* Task context menu -- rendered in portal via TaskContextMenu */}
      {taskMenuAnchor && (
        <TaskContextMenu
          anchorRect={taskMenuAnchor.rect}
          currentStatus={taskMenuAnchor.task.workflowStatus}
          isArchived={false}
          collections={collections}
          currentCollectionId={taskMenuAnchor.task.collectionId ?? null}
          onStatusChange={handleTaskStatusChange}
          onMoveToCollection={handleTaskMoveToCollection}
          onArchive={handleTaskArchive}
          onUnarchive={() => setTaskMenuAnchor(null)}
          onRename={handleTaskRenameStart}
          onDelete={handleTaskDelete}
          onOpenInNewTab={handleTaskOpenInNewTab}
          onGenerateTitle={handleTaskGenerateTitle}
          isRunning={taskMenuIsRunning}
          onStopProcess={taskMenuIsRunning ? handleTaskStopProcess : undefined}
          onClose={handleTaskMenuClose}
        />
      )}

      {/* Delete session confirmation dialog */}
      <DeleteSessionDialog
        session={sessionToDelete}
        isOpen={sessionToDelete !== null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setSessionToDelete(null)}
      />

      <DeleteTaskDialog
        task={taskToDelete}
        isOpen={taskToDelete !== null}
        onConfirm={handleConfirmTaskDelete}
        onCancel={() => setTaskToDelete(null)}
      />

      {/* Move to project dialog */}
      <MoveProjectDialog
        session={moveSessionTarget}
        isOpen={moveSessionTarget !== null}
        onConfirm={handleMoveConfirm}
        onCancel={() => setMoveSessionTarget(null)}
      />
    </div>
  );
});
