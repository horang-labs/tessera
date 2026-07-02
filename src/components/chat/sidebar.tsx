'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Check, CircleDot, CircleStop, ListCollapse, ListTree } from 'lucide-react';
import { useSessionStore } from '@/stores/session-store';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import { useCollectionDnd } from '@/hooks/use-collection-dnd';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { CollectionGroup } from './collection-group';
import { AllProjectsList } from './all-projects-list';
import { RecentWorkSection } from './recent-work-section';
import { MoveProjectDialog } from './move-project-dialog';
import { DeleteSessionDialog } from './delete-session-dialog';
import { useBoardStore } from '@/stores/board-store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChatStore } from '@/stores/chat-store';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import logger from '@/lib/logger';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import {
  buildProjectCollectionGroups,
  countRunningCollectionGroupItems,
  filterCollectionGroupsByRunning,
  getRunningCollectionGroupSessionIds,
  type CollectionGroupData,
} from '@/lib/chat/build-collection-groups';
import { wsClient } from '@/lib/ws/client';
import { useCollectionStore } from '@/stores/collection-store';
import { useTaskStore } from '@/stores/task-store';
import type { TaskEntity, WorkflowStatus } from '@/types/task-entity';
import type { Collection } from '@/types/collection';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import { Tooltip } from '@/components/ui/tooltip';
import {
  SidebarAddCollectionControl,
  SidebarEmptyState,
  SidebarLoadingState,
} from './sidebar-sections';
import {
  buildSidebarOrderedSessionIds,
  findSidebarProject,
} from './sidebar-utils';
import { buildRecentWorkItems } from '@/lib/chat/recent-work';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { cn } from '@/lib/utils';

const EMPTY_COLLECTIONS: Collection[] = [];

function getCollectionGroupScopeKey(projectId: string, group: CollectionGroupData): string {
  return `${projectId}::${group.collectionId ?? '__uncategorized'}`;
}

interface ProjectListContextHeaderProps {
  hasExpandableGroups: boolean;
  allGroupsCollapsed: boolean;
  isRunningFilterActive: boolean;
  runningItemCount: number;
  canStopAllRunning: boolean;
  expandAllLabel: string;
  collapseAllLabel: string;
  allLabel: string;
  runningLabel: string;
  stopAllLabel: string;
  confirmStopAllLabel: string;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onShowAll: () => void;
  onShowRunning: () => void;
  onStopAllRunning: () => void;
}

function ProjectListContextHeader({
  hasExpandableGroups,
  allGroupsCollapsed,
  isRunningFilterActive,
  runningItemCount,
  canStopAllRunning,
  expandAllLabel,
  collapseAllLabel,
  allLabel,
  runningLabel,
  stopAllLabel,
  confirmStopAllLabel,
  onExpandAll,
  onCollapseAll,
  onShowAll,
  onShowRunning,
  onStopAllRunning,
}: ProjectListContextHeaderProps) {
  const projectActionLabel = allGroupsCollapsed ? expandAllLabel : collapseAllLabel;
  const ProjectActionIcon = allGroupsCollapsed ? ListTree : ListCollapse;
  const runningCountLabel = runningItemCount > 99 ? '99+' : String(runningItemCount);
  const [isStopAllConfirming, setIsStopAllConfirming] = useState(false);
  const stopAllConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isStopAllConfirmationActive = isStopAllConfirming && isRunningFilterActive && canStopAllRunning;

  const handleProjectAction = useCallback(() => {
    if (!hasExpandableGroups) return;
    if (allGroupsCollapsed) {
      onExpandAll();
      return;
    }
    onCollapseAll();
  }, [allGroupsCollapsed, hasExpandableGroups, onCollapseAll, onExpandAll]);

  const clearStopAllConfirmTimer = useCallback(() => {
    if (stopAllConfirmTimerRef.current) {
      clearTimeout(stopAllConfirmTimerRef.current);
      stopAllConfirmTimerRef.current = null;
    }
  }, []);

  const resetStopAllConfirmation = useCallback(() => {
    clearStopAllConfirmTimer();
    setIsStopAllConfirming(false);
  }, [clearStopAllConfirmTimer]);

  const handleStopAllClick = useCallback(() => {
    if (!canStopAllRunning) return;

    if (!isStopAllConfirmationActive) {
      setIsStopAllConfirming(true);
      clearStopAllConfirmTimer();
      stopAllConfirmTimerRef.current = setTimeout(() => {
        stopAllConfirmTimerRef.current = null;
        setIsStopAllConfirming(false);
      }, 2400);
      return;
    }

    resetStopAllConfirmation();
    onStopAllRunning();
  }, [
    canStopAllRunning,
    clearStopAllConfirmTimer,
    isStopAllConfirmationActive,
    onStopAllRunning,
    resetStopAllConfirmation,
  ]);

  const handleShowAll = useCallback(() => {
    resetStopAllConfirmation();
    onShowAll();
  }, [onShowAll, resetStopAllConfirmation]);

  useEffect(() => clearStopAllConfirmTimer, [clearStopAllConfirmTimer]);

  return (
    <div
      className="shrink-0 bg-(--board-bg) px-2 py-2"
      data-testid="sidebar-project-context"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="grid h-6 min-w-0 flex-1 grid-cols-2 rounded-md border border-(--divider) bg-(--sidebar-bg) p-px"
          role="group"
          aria-label="Session filters"
          data-testid="sidebar-filter-bar"
        >
          <button
            type="button"
            onClick={handleShowAll}
            aria-pressed={!isRunningFilterActive}
            className={cn(
              'min-w-0 rounded px-1.5 text-[0.6875rem] font-medium leading-none transition-colors',
              !isRunningFilterActive
                ? 'bg-(--sidebar-hover) text-(--sidebar-text-active)'
                : 'text-(--text-muted) hover:text-(--sidebar-text-active)',
            )}
            data-testid="sidebar-all-filter"
          >
            <span className="block truncate">{allLabel}</span>
          </button>
          <button
            type="button"
            onClick={onShowRunning}
            aria-pressed={isRunningFilterActive}
            className={cn(
              'flex min-w-0 items-center justify-center gap-1 rounded px-1.5 text-[0.6875rem] font-medium leading-none transition-colors',
              isRunningFilterActive
                ? 'bg-[color-mix(in_srgb,var(--success)_13%,var(--sidebar-hover))] text-(--sidebar-text-active)'
                : 'text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--success)_7%,transparent)] hover:text-(--sidebar-text-active)',
            )}
            data-testid="sidebar-running-filter"
          >
            <CircleDot
              className={cn(
                'h-2.5 w-2.5 shrink-0',
                isRunningFilterActive || runningItemCount > 0 ? 'text-(--success)' : 'text-(--text-muted)',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{runningLabel}</span>
            <span
              className={cn(
                'shrink-0 text-[0.625rem] tabular-nums',
                isRunningFilterActive ? 'text-(--sidebar-text-active)' : 'text-(--text-muted)',
              )}
            >
              {runningCountLabel}
            </span>
          </button>
        </div>
        {isRunningFilterActive ? (
          <Tooltip content={isStopAllConfirmationActive ? confirmStopAllLabel : stopAllLabel} delay={300}>
            <button
              type="button"
              onClick={handleStopAllClick}
              disabled={!canStopAllRunning}
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--error) transition-colors',
                'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
                'disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent',
                isStopAllConfirmationActive && 'bg-[color-mix(in_srgb,var(--error)_12%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--error)_35%,transparent)]',
              )}
              aria-label={isStopAllConfirmationActive ? confirmStopAllLabel : stopAllLabel}
              data-testid="sidebar-stop-all-running"
            >
              {isStopAllConfirmationActive ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <CircleStop className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        ) : (
          <Tooltip content={projectActionLabel} delay={300}>
            <button
              type="button"
              onClick={handleProjectAction}
              disabled={!hasExpandableGroups}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active) focus-visible:bg-(--sidebar-hover) focus-visible:text-(--sidebar-text-active) disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-(--text-muted)"
              aria-label={projectActionLabel}
              data-testid="sidebar-project-context-action"
            >
              <ProjectActionIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function SidebarRunningFilterEmpty({ label }: { label: string }) {
  return (
    <div
      className="mx-3 mt-10 rounded-lg border border-dashed border-(--divider) px-3 py-5 text-center"
      data-testid="sidebar-running-filter-empty"
    >
      <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-(--success)">
        <CircleDot className="h-4 w-4" aria-hidden="true" />
      </div>
      <p className="text-[0.75rem] font-medium text-(--sidebar-text-active)">
        {label}
      </p>
    </div>
  );
}

export function Sidebar() {
  const { t } = useI18n();
  const projects = useSessionStore((state) => state.projects);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const { deleteSession, renameSession, generateTitle } = useSessionCrud();
  const { viewSession } = useSessionNavigation();

  // activePanelId: still needed reactively for CASE B3 (assign to current active panel)
  const activePanelId = usePanelStore((state) => selectActiveTab(state)?.activePanelId ?? '');
  const activePanelSessionId = usePanelStore((state) => {
    const tab = selectActiveTab(state);
    return tab?.panels[tab.activePanelId]?.sessionId ?? null;
  });
  const visibleSessionId = activePanelSessionId ?? activeSessionId;
  const selectionSessionId = getSessionSelectionId(visibleSessionId);

  // Board store — status group collapse state
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const collapsedCollections = useBoardStore((state) => state.collapsedCollections ?? {});
  const toggleCollectionCollapse = useBoardStore((state) => state.toggleCollectionCollapse ?? (() => {}));
  const setCollectionCollapsed = useBoardStore((state) => state.setCollectionCollapsed ?? (() => {}));
  const allProjectsExpandedSections = useBoardStore((state) => state.allProjectsExpandedSections ?? {});
  const setAllProjectsSectionsExpanded = useBoardStore(
    (state) => state.setAllProjectsSectionsExpanded ?? (() => {}),
  );
  const storedRunningFilterActive = useBoardStore((state) => state.isListRunningFilterActive ?? false);
  const setStoredRunningFilterActive = useBoardStore(
    (state) => state.setListRunningFilterActive ?? (() => {}),
  );

  // Collection & Task stores
  const collections = useCollectionStore((state) =>
    selectedProjectDir && selectedProjectDir !== ALL_PROJECTS_SENTINEL
      ? state.collectionsByProject?.[selectedProjectDir] ?? EMPTY_COLLECTIONS
      : EMPTY_COLLECTIONS,
  );
  const tasks = useTaskStore((state) => state.tasks);
  const tasksByProject = useTaskStore((state) => state.tasksByProject);

  // Load collections and tasks on mount / when selectedProject changes
  useEffect(() => {
    if (!selectedProjectDir || selectedProjectDir === ALL_PROJECTS_SENTINEL) return;
    void useCollectionStore.getState().loadCollections(selectedProjectDir);
  }, [selectedProjectDir]);

  useEffect(() => {
    if (selectedProjectDir && selectedProjectDir !== ALL_PROJECTS_SENTINEL) {
      useTaskStore.getState().loadTasks(selectedProjectDir);
    }
  }, [selectedProjectDir]);

  // Collection DnD (item moves between collections + group reorder)
  const {
    draggingItem: draggingCollectionItem,
    dragOverCollectionId,
    collectionDropIndicator,
    handleItemDragStart: handleCollectionItemDragStart,
    handleItemDragEnd: handleCollectionItemDragEnd,
    handleCollectionDragOver: handleCollectionGroupDragOver,
    handleCollectionDragLeave: handleCollectionGroupDragLeave,
    handleCollectionDrop: handleCollectionGroupDrop,
    handleItemDragOverItem: handleCollectionItemDragOverItem,
    draggingGroupId,
    groupDragOverIndex,
    handleGroupDragStart: handleCollGroupDragStart,
    handleGroupDragEnd: handleCollGroupDragEnd,
    handleGroupDragOver: handleCollGroupDragOver,
    handleGroupDragLeave: handleCollGroupDragLeave,
    handleGroupDrop: handleCollGroupDrop,
  } = useCollectionDnd();

  // orderedIds + click handlers are declared after collectionGroups (below)

  // Context menu action handlers
  const handleTaskStatusChangeById = useCallback((taskId: string, status: string) => {
    useTaskStore.getState().updateTask(taskId, { workflowStatus: status as WorkflowStatus });
  }, []);

  const handleChatStatusChangeById = useCallback((sessionId: string, status: string) => {
    useSessionStore.getState().updateChatWorkflowStatus(
      sessionId,
      status === 'chat' ? null : status as WorkflowStatus,
    );
  }, []);

  const handleTaskEntityRename = useCallback((taskId: string, title: string) => {
    void useTaskStore.getState().updateTask(taskId, { title });
  }, []);

  const handleTaskEntityDelete = useCallback((taskId: string) => {
    void useTaskStore.getState().deleteTask(taskId);
  }, []);

  const handleTaskArchive = useCallback((taskId: string) => {
    const task = useTaskStore.getState().getTask(taskId);
    if (task) {
      void useTaskStore.getState().toggleTaskArchive(taskId, true);
      return;
    }
    useSessionStore.getState().toggleArchive(taskId, true);
  }, []);

  const handleTaskRename = useCallback(async (taskId: string, newTitle: string) => {
    await renameSession(taskId, newTitle);
  }, [renameSession]);

  const [sessionToDelete, setSessionToDelete] = useState<UnifiedSession | null>(null);

  const handleTaskDelete = useCallback((taskId: string) => {
    const session = useSessionStore.getState().getSession(taskId);
    if (session) setSessionToDelete(session);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!sessionToDelete) return;
    await deleteSession(sessionToDelete.id);
    setSessionToDelete(null);
  }, [sessionToDelete, deleteSession]);

  const handleTaskOpenInNewTab = useCallback(async (taskId: string) => {
    const session = useSessionStore.getState().getSession(taskId);
    if (!session) return;
    useTabStore.getState().createTabWithSession(taskId);
    await viewSession(session);
  }, [viewSession]);

  const handleTaskGenerateTitle = useCallback(async (taskId: string) => {
    await generateTitle(taskId);
  }, [generateTitle]);

  const [addingCollection, setAddingCollection] = useState(false);
  const [newCollectionLabel, setNewCollectionLabel] = useState('');
  const resetCollectionComposer = useCallback(() => {
    setAddingCollection(false);
    setNewCollectionLabel('');
  }, []);

  const handleAddCollection = useCallback(async () => {
    const label = newCollectionLabel.trim();
    if (!label) {
      resetCollectionComposer();
      return;
    }
    if (!selectedProjectDir || selectedProjectDir === ALL_PROJECTS_SENTINEL) {
      resetCollectionComposer();
      return;
    }
    await useCollectionStore.getState().addCollection(selectedProjectDir, label, '#a78bfa');
    resetCollectionComposer();
  }, [newCollectionLabel, resetCollectionComposer, selectedProjectDir]);

  const [isInitialized, setIsInitialized] = useState(false);
  const [moveSessionTarget, setMoveSessionTarget] = useState<UnifiedSession | null>(null);

  const handleTaskMoveToProject = useCallback((taskId: string) => {
    const session = useSessionStore.getState().getSession(taskId);
    if (session) setMoveSessionTarget(session);
  }, []);

  const handleTaskStopProcess = useCallback((taskId: string) => {
    wsClient.stopSession(taskId);
    useSessionStore.getState().clearUnreadCount(taskId);
    wsClient.sendMarkAsRead(taskId);
  }, []);

  const handleMoveConfirm = useCallback((targetProjectId: string) => {
    if (!moveSessionTarget) return;
    useSessionStore.getState().moveSession(moveSessionTarget.id, targetProjectId);
    setMoveSessionTarget(null);
  }, [moveSessionTarget]);
  const prevActivePanelIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevActivePanelIdRef.current === null) {
      prevActivePanelIdRef.current = activePanelId;
      return;
    }
    if (prevActivePanelIdRef.current === activePanelId) return;
    prevActivePanelIdRef.current = activePanelId;

    if (!selectionSessionId) return;

    const scrollToSession = () => {
      const sessionEl = document.querySelector(`[data-session-id="${selectionSessionId}"]`);
      if (sessionEl) {
        sessionEl.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'nearest' });
        return true;
      }
      return false;
    };

    if (scrollToSession()) return;

    let attempts = 0;
    const maxAttempts = 5;
    const retryId = setInterval(() => {
      attempts++;
      if (scrollToSession() || attempts >= maxAttempts) {
        clearInterval(retryId);
      }
    }, 50);

    return () => clearInterval(retryId);
  }, [activePanelId, selectionSessionId]);

  const hasInitRef = useRef(false);
  useEffect(() => {
    if (hasInitRef.current) return;
    if (projects.length === 0) {
      if (selectedProjectDir === ALL_PROJECTS_SENTINEL) {
        hasInitRef.current = true;
        setIsInitialized(true);
      }
      return;
    }
    hasInitRef.current = true;
    setIsInitialized(true);

    const activeId = useSessionStore.getState().activeSessionId;
    if (activeId) {
      const session = useSessionStore.getState().getSession(activeId);
      if (session) {
        viewSession(session).catch((err) => {
          logger.error('Failed to load active session', {
            sessionId: activeId,
            error: err,
          });
          useChatStore.getState().setError(activeId, t('errors.sessionLoadFailed'));
          toast.error(t('errors.sessionLoadFailed'));
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, selectedProjectDir]);

  const selectedProject = useMemo(() => {
    return findSidebarProject(projects, selectedProjectDir);
  }, [projects, selectedProjectDir]);

  const collectionGroups = useMemo(() => {
    if (!selectedProject) return null;
    return buildProjectCollectionGroups(selectedProject, collections, tasks);
  }, [selectedProject, collections, tasks]);

  const [isRunningFilterActive, setLocalRunningFilterActive] = useState(storedRunningFilterActive);
  useEffect(() => {
    setLocalRunningFilterActive(storedRunningFilterActive);
  }, [storedRunningFilterActive]);
  const setIsRunningFilterActive = useCallback(
    (active: boolean) => {
      setLocalRunningFilterActive(active);
      setStoredRunningFilterActive(active);
    },
    [setStoredRunningFilterActive],
  );
  const isAllMode = selectedProjectDir === ALL_PROJECTS_SENTINEL;

  const allProjectSectionIds = useMemo(
    () => projects.map((project) => project.encodedDir),
    [projects],
  );

  const allProjectsRunningSessionIds = useMemo(() => {
    const sessionIds = new Set<string>();

    for (const project of projects) {
      for (const session of project.sessions) {
        if (!session.archived && session.isRunning) {
          sessionIds.add(session.id);
        }
      }
    }

    return Array.from(sessionIds);
  }, [projects]);

  const runningItemCount = useMemo(() => {
    if (!collectionGroups) return 0;
    return countRunningCollectionGroupItems(collectionGroups);
  }, [collectionGroups]);

  const visibleCollectionGroups = useMemo(() => {
    if (!collectionGroups) return null;
    if (!isRunningFilterActive) return collectionGroups;
    return filterCollectionGroupsByRunning(collectionGroups);
  }, [collectionGroups, isRunningFilterActive]);

  const runningFlatItems = useMemo(() => {
    const flatTasks: TaskEntity[] = [];
    const flatChats: UnifiedSession[] = [];
    if (!isRunningFilterActive || !visibleCollectionGroups) {
      return { tasks: flatTasks, chats: flatChats };
    }

    for (const group of visibleCollectionGroups) {
      flatTasks.push(...group.tasks);
      flatChats.push(...group.chats);
    }

    return { tasks: flatTasks, chats: flatChats };
  }, [isRunningFilterActive, visibleCollectionGroups]);

  const runningSessionIds = useMemo(() => {
    if (!isRunningFilterActive || !visibleCollectionGroups) return [];
    return getRunningCollectionGroupSessionIds(visibleCollectionGroups);
  }, [isRunningFilterActive, visibleCollectionGroups]);

  const handleStopAllRunning = useCallback(() => {
    const sessionStore = useSessionStore.getState();
    const sessionIds = isAllMode ? allProjectsRunningSessionIds : runningSessionIds;

    for (const sessionId of sessionIds) {
      wsClient.stopSession(sessionId);
      sessionStore.clearUnreadCount(sessionId);
      wsClient.sendMarkAsRead(sessionId);
    }
  }, [allProjectsRunningSessionIds, isAllMode, runningSessionIds]);

  const orderedIds = useMemo(() => {
    return buildSidebarOrderedSessionIds({
      selectedProjectDir,
      projects,
      selectedProject,
      collectionGroups: visibleCollectionGroups,
    });
  }, [projects, selectedProject, selectedProjectDir, visibleCollectionGroups]);

  const { handleSessionClick, handleSessionDoubleClick } = useSessionClickHandlers({ orderedIds });

  const recentWorkItems = useMemo(() => {
    const scopedProjects = isAllMode
      ? projects
      : selectedProject
        ? [selectedProject]
        : [];

    return buildRecentWorkItems({
      projects: scopedProjects,
      tasksByProject,
      limit: 8,
    });
  }, [isAllMode, projects, selectedProject, tasksByProject]);

  const collectionGroupScopeKeys = useMemo(() => {
    if (!selectedProject || !visibleCollectionGroups) return [];
    return visibleCollectionGroups
      .filter((group) => group.tasks.length + group.chats.length > 0)
      .map((group) => getCollectionGroupScopeKey(selectedProject.encodedDir, group));
  }, [selectedProject, visibleCollectionGroups]);

  const setAllCollectionGroupsCollapsed = useCallback(
    (collapsed: boolean) => {
      for (const key of collectionGroupScopeKeys) {
        setCollectionCollapsed(key, collapsed);
      }
    },
    [collectionGroupScopeKeys, setCollectionCollapsed],
  );

  const areAllCollectionGroupsCollapsed =
    collectionGroupScopeKeys.length > 0 &&
    collectionGroupScopeKeys.every((key) => collapsedCollections[key]);

  const setAllProjectSectionsExpanded = useCallback(
    (expanded: boolean) => {
      setAllProjectsSectionsExpanded(allProjectSectionIds, expanded);
    },
    [allProjectSectionIds, setAllProjectsSectionsExpanded],
  );

  const areAllProjectSectionsCollapsed =
    allProjectSectionIds.length > 0 &&
    allProjectSectionIds.every((projectId) => !allProjectsExpandedSections[projectId]);

  return (
    <div className="h-full flex flex-col bg-(--board-bg)" data-testid="sidebar">
      {isInitialized && isAllMode ? (
        <ProjectListContextHeader
          hasExpandableGroups={!isRunningFilterActive && allProjectSectionIds.length > 0}
          allGroupsCollapsed={areAllProjectSectionsCollapsed}
          isRunningFilterActive={isRunningFilterActive}
          runningItemCount={allProjectsRunningSessionIds.length}
          canStopAllRunning={allProjectsRunningSessionIds.length > 0}
          expandAllLabel={t('sidebar.expandAll')}
          collapseAllLabel={t('sidebar.collapseAll')}
          allLabel={t('common.all')}
          runningLabel={t('status.running')}
          stopAllLabel={t('status.stopAll')}
          confirmStopAllLabel={t('status.confirmStopAll')}
          onExpandAll={() => setAllProjectSectionsExpanded(true)}
          onCollapseAll={() => setAllProjectSectionsExpanded(false)}
          onShowAll={() => setIsRunningFilterActive(false)}
          onShowRunning={() => setIsRunningFilterActive(true)}
          onStopAllRunning={handleStopAllRunning}
        />
      ) : isInitialized && collectionGroups && selectedProject ? (
        <ProjectListContextHeader
          hasExpandableGroups={!isRunningFilterActive && collectionGroupScopeKeys.length > 0}
          allGroupsCollapsed={areAllCollectionGroupsCollapsed}
          isRunningFilterActive={isRunningFilterActive}
          runningItemCount={runningItemCount}
          canStopAllRunning={runningSessionIds.length > 0}
          expandAllLabel={t('sidebar.expandAll')}
          collapseAllLabel={t('sidebar.collapseAll')}
          allLabel={t('common.all')}
          runningLabel={t('status.running')}
          stopAllLabel={t('status.stopAll')}
          confirmStopAllLabel={t('status.confirmStopAll')}
          onExpandAll={() => setAllCollectionGroupsCollapsed(false)}
          onCollapseAll={() => setAllCollectionGroupsCollapsed(true)}
          onShowAll={() => setIsRunningFilterActive(false)}
          onShowRunning={() => setIsRunningFilterActive(true)}
          onStopAllRunning={handleStopAllRunning}
        />
      ) : null}
      <ScrollArea
        className="min-h-0 flex-1 px-1 py-2 [scrollbar-gutter:stable]"
        data-testid="sidebar-scroll-area"
      >
        {!isInitialized ? (
          <SidebarLoadingState label={t('common.loading')} />
        ) : isAllMode ? (
          projects.length === 0 ? (
            <SidebarEmptyState
              title={t('sidebar.noProjects')}
              description={t('sidebar.runFromProject')}
            />
          ) : isRunningFilterActive && allProjectsRunningSessionIds.length === 0 ? (
            <SidebarRunningFilterEmpty label={t('status.noRunningProcesses')} />
          ) : (
            <>
              {!isRunningFilterActive && (
                <RecentWorkSection
                  items={recentWorkItems}
                  contextMenuCollections={EMPTY_COLLECTIONS}
                  projectId={ALL_PROJECTS_SENTINEL}
                  projectDir=""
                  activeSessionId={selectionSessionId}
                  onSessionClick={handleSessionClick}
                  onSessionDoubleClick={handleSessionDoubleClick}
                  onTaskRename={handleTaskEntityRename}
                  onTaskDelete={handleTaskEntityDelete}
                  onTaskStatusChange={handleTaskStatusChangeById}
                  onChatStatusChange={handleChatStatusChangeById}
                  onSessionRename={handleTaskRename}
                  onSessionDelete={handleTaskDelete}
                  onSessionArchive={handleTaskArchive}
                  onSessionOpenInNewTab={handleTaskOpenInNewTab}
                  onSessionGenerateTitle={handleTaskGenerateTitle}
                  onSessionMoveToProject={handleTaskMoveToProject}
                  onSessionStopProcess={handleTaskStopProcess}
                />
              )}
              <AllProjectsList
                activeSessionId={selectionSessionId}
                isRunningFilterActive={isRunningFilterActive}
                onSessionClick={handleSessionClick}
                onSessionDoubleClick={handleSessionDoubleClick}
                onSessionArchive={handleTaskArchive}
                onChatStatusChange={handleChatStatusChangeById}
                onSessionRename={handleTaskRename}
                onSessionDelete={handleTaskDelete}
                onSessionOpenInNewTab={handleTaskOpenInNewTab}
                onSessionGenerateTitle={handleTaskGenerateTitle}
                onSessionMoveToProject={handleTaskMoveToProject}
                onSessionStopProcess={handleTaskStopProcess}
              />
            </>
          )
        ) : visibleCollectionGroups && selectedProject ? (
          <>
            {isRunningFilterActive && runningFlatItems.tasks.length + runningFlatItems.chats.length === 0 ? (
              <SidebarRunningFilterEmpty label={t('status.noRunningProcesses')} />
            ) : isRunningFilterActive ? (
              <CollectionGroup
                key="running-flat"
                collection={null}
                contextMenuCollections={collections}
                projectId={selectedProject.encodedDir}
                projectDir={selectedProject.decodedPath}
                tasks={runningFlatItems.tasks}
                chats={runningFlatItems.chats}
                collapsed={false}
                onToggleCollapse={() => {}}
                onSessionClick={handleSessionClick}
                onSessionDoubleClick={handleSessionDoubleClick}
                activeSessionId={selectionSessionId}
                isDragActive={false}
                isDragOver={false}
                onItemDragStart={handleCollectionItemDragStart}
                onItemDragEnd={handleCollectionItemDragEnd}
                onCollectionDragOver={handleCollectionGroupDragOver}
                onCollectionDragLeave={handleCollectionGroupDragLeave}
                onCollectionDrop={handleCollectionGroupDrop}
                onItemDragOverItem={handleCollectionItemDragOverItem}
                dropIndicator={null}
                isGroupDragging={false}
                isGroupDragOver={false}
                onGroupDragStart={handleCollGroupDragStart}
                onGroupDragEnd={handleCollGroupDragEnd}
                onGroupDragOver={(e) => handleCollGroupDragOver(0, e)}
                onGroupDragLeave={(e) => handleCollGroupDragLeave(0, e)}
                onGroupDrop={(e) => handleCollGroupDrop(selectedProject.encodedDir, 0, e)}
                onTaskRename={handleTaskEntityRename}
                onTaskDelete={handleTaskEntityDelete}
                onTaskStatusChange={handleTaskStatusChangeById}
                onChatStatusChange={handleChatStatusChangeById}
                onSessionRename={handleTaskRename}
                onSessionDelete={handleTaskDelete}
                onSessionArchive={handleTaskArchive}
                onSessionOpenInNewTab={handleTaskOpenInNewTab}
                onSessionGenerateTitle={handleTaskGenerateTitle}
                onSessionMoveToProject={handleTaskMoveToProject}
                onSessionStopProcess={handleTaskStopProcess}
                disableDnd
                allowPanelSessionDnd
                hideHeader
              />
            ) : (
              <>
                <RecentWorkSection
                  items={recentWorkItems}
                  contextMenuCollections={collections}
                  projectId={selectedProject.encodedDir}
                  projectDir={selectedProject.decodedPath}
                  activeSessionId={selectionSessionId}
                  onSessionClick={handleSessionClick}
                  onSessionDoubleClick={handleSessionDoubleClick}
                  onTaskRename={handleTaskEntityRename}
                  onTaskDelete={handleTaskEntityDelete}
                  onTaskStatusChange={handleTaskStatusChangeById}
                  onChatStatusChange={handleChatStatusChangeById}
                  onSessionRename={handleTaskRename}
                  onSessionDelete={handleTaskDelete}
                  onSessionArchive={handleTaskArchive}
                  onSessionOpenInNewTab={handleTaskOpenInNewTab}
                  onSessionGenerateTitle={handleTaskGenerateTitle}
                  onSessionMoveToProject={handleTaskMoveToProject}
                  onSessionStopProcess={handleTaskStopProcess}
                />
                {visibleCollectionGroups.map((group, groupIdx) => {
                  const colId = group.collectionId;
                  const collection = colId ? collections.find((c) => c.id === colId) ?? null : null;
                  const key = colId ?? '__uncategorized';
                  const scopedKey = `${selectedProject.encodedDir}::${key}`;

                  return (
                    <CollectionGroup
                      key={scopedKey}
                      collection={collection}
                      contextMenuCollections={collections}
                      projectId={selectedProject.encodedDir}
                      projectDir={selectedProject.decodedPath}
                      tasks={group.tasks}
                      chats={group.chats}
                      collapsed={collapsedCollections[scopedKey] ?? false}
                      onToggleCollapse={() => toggleCollectionCollapse(scopedKey)}
                      onSessionClick={handleSessionClick}
                      onSessionDoubleClick={handleSessionDoubleClick}
                      activeSessionId={selectionSessionId}
                      // Item DnD
                      isDragActive={draggingCollectionItem?.projectId === selectedProject.encodedDir}
                      isDragOver={dragOverCollectionId === scopedKey}
                      onItemDragStart={handleCollectionItemDragStart}
                      onItemDragEnd={handleCollectionItemDragEnd}
                      onCollectionDragOver={handleCollectionGroupDragOver}
                      onCollectionDragLeave={handleCollectionGroupDragLeave}
                      onCollectionDrop={handleCollectionGroupDrop}
                      onItemDragOverItem={handleCollectionItemDragOverItem}
                      dropIndicator={
                        draggingCollectionItem?.projectId === selectedProject.encodedDir
                          ? collectionDropIndicator
                          : null
                      }
                      // Group DnD
                      isGroupDragging={draggingGroupId === scopedKey}
                      isGroupDragOver={
                        (draggingGroupId?.startsWith(`${selectedProject.encodedDir}::`) ?? false) &&
                        groupDragOverIndex === groupIdx
                      }
                      onGroupDragStart={handleCollGroupDragStart}
                      onGroupDragEnd={handleCollGroupDragEnd}
                      onGroupDragOver={(e) => handleCollGroupDragOver(groupIdx, e)}
                      onGroupDragLeave={(e) => handleCollGroupDragLeave(groupIdx, e)}
                      onGroupDrop={(e) => handleCollGroupDrop(selectedProject.encodedDir, groupIdx, e)}
                      // Actions
                      onTaskRename={handleTaskEntityRename}
                      onTaskDelete={handleTaskEntityDelete}
                      onTaskStatusChange={handleTaskStatusChangeById}
                      onChatStatusChange={handleChatStatusChangeById}
                      onSessionRename={handleTaskRename}
                      onSessionDelete={handleTaskDelete}
                      onSessionArchive={handleTaskArchive}
                      onSessionOpenInNewTab={handleTaskOpenInNewTab}
                      onSessionGenerateTitle={handleTaskGenerateTitle}
                      onSessionMoveToProject={handleTaskMoveToProject}
                      onSessionStopProcess={handleTaskStopProcess}
                      disableDnd={isRunningFilterActive}
                    />
                  );
                })}
              </>
            )}
            {!isRunningFilterActive && (
              <SidebarAddCollectionControl
                isAdding={addingCollection}
                value={newCollectionLabel}
                onStartAdding={() => setAddingCollection(true)}
                onValueChange={setNewCollectionLabel}
                onSubmit={handleAddCollection}
                onCancel={resetCollectionComposer}
              />
            )}
          </>
        ) : projects.length === 0 ? (
          <SidebarEmptyState
            title={t('sidebar.noProjects')}
            description={t('sidebar.runFromProject')}
          />
        ) : null}
      </ScrollArea>

      <DeleteSessionDialog
        session={sessionToDelete}
        isOpen={sessionToDelete !== null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setSessionToDelete(null)}
      />

      <MoveProjectDialog
        session={moveSessionTarget}
        isOpen={moveSessionTarget !== null}
        onConfirm={handleMoveConfirm}
        onCancel={() => setMoveSessionTarget(null)}
      />
    </div>
  );
}
