'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ListCollapse, ListTree } from 'lucide-react';
import { useSessionStore } from '@/stores/session-store';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useSessionClickHandlers } from '@/hooks/use-session-click-handlers';
import { useCollectionDnd } from '@/hooks/use-collection-dnd';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { CollectionGroup } from './collection-group';
import { AllProjectsList } from './all-projects-list';
import { MoveProjectDialog } from './move-project-dialog';
import { DeleteSessionDialog } from './delete-session-dialog';
import { useBoardStore } from '@/stores/board-store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChatStore } from '@/stores/chat-store';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import logger from '@/lib/logger';
import { ALL_PROJECTS_SENTINEL, getProjectColor } from '@/lib/constants/project-strip';
import { buildProjectCollectionGroups, type CollectionGroupData } from '@/lib/chat/build-collection-groups';
import { wsClient } from '@/lib/ws/client';
import { useCollectionStore } from '@/stores/collection-store';
import { useTaskStore } from '@/stores/task-store';
import type { WorkflowStatus } from '@/types/task-entity';
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
import { getSessionSelectionId } from '@/lib/constants/special-sessions';

const EMPTY_COLLECTIONS: Collection[] = [];

function getCollectionGroupScopeKey(projectId: string, group: CollectionGroupData): string {
  return `${projectId}::${group.collectionId ?? '__uncategorized'}`;
}

interface ProjectListContextHeaderProps {
  project: ProjectGroup;
  hasExpandableGroups: boolean;
  allGroupsCollapsed: boolean;
  expandAllLabel: string;
  collapseAllLabel: string;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

function ProjectListContextHeader({
  project,
  hasExpandableGroups,
  allGroupsCollapsed,
  expandAllLabel,
  collapseAllLabel,
  onExpandAll,
  onCollapseAll,
}: ProjectListContextHeaderProps) {
  const projectInitial = project.displayName.trim().charAt(0).toUpperCase() || '?';
  const projectActionLabel = allGroupsCollapsed ? expandAllLabel : collapseAllLabel;
  const ProjectActionIcon = allGroupsCollapsed ? ListTree : ListCollapse;

  const handleProjectAction = useCallback(() => {
    if (!hasExpandableGroups) return;
    if (allGroupsCollapsed) {
      onExpandAll();
      return;
    }
    onCollapseAll();
  }, [allGroupsCollapsed, hasExpandableGroups, onCollapseAll, onExpandAll]);

  return (
    <div
      className="shrink-0 border-b border-(--divider) bg-(--board-bg) px-2 py-1.5"
      data-testid="sidebar-project-context"
    >
      <div className="flex min-w-0 items-center gap-2 rounded-md py-1 text-(--sidebar-text-active)">
        <div
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[0.625rem] font-bold leading-none text-white shadow-sm"
          style={{ backgroundColor: getProjectColor(project.displayName) }}
          aria-hidden="true"
        >
          {projectInitial}
        </div>
        <div className="min-w-0 flex-1" title={project.decodedPath}>
          <div className="truncate text-[0.8125rem] font-semibold leading-5">
            {project.displayName}
          </div>
        </div>
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
      </div>
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

  // Collection & Task stores
  const collections = useCollectionStore((state) =>
    selectedProjectDir && selectedProjectDir !== ALL_PROJECTS_SENTINEL
      ? state.collectionsByProject?.[selectedProjectDir] ?? EMPTY_COLLECTIONS
      : EMPTY_COLLECTIONS,
  );
  const tasks = useTaskStore((state) => state.tasks);

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
    if (projects.length === 0) return;
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
  }, [projects]);

  const selectedProject = useMemo(() => {
    return findSidebarProject(projects, selectedProjectDir);
  }, [projects, selectedProjectDir]);

  const collectionGroups = useMemo(() => {
    if (!selectedProject) return null;
    return buildProjectCollectionGroups(selectedProject, collections, tasks);
  }, [selectedProject, collections, tasks]);

  const orderedIds = useMemo(() => {
    return buildSidebarOrderedSessionIds({
      selectedProjectDir,
      projects,
      selectedProject,
      collectionGroups,
    });
  }, [collectionGroups, projects, selectedProject, selectedProjectDir]);

  const { handleSessionClick, handleSessionDoubleClick } = useSessionClickHandlers({ orderedIds });

  const isAllMode = selectedProjectDir === ALL_PROJECTS_SENTINEL;

  const collectionGroupScopeKeys = useMemo(() => {
    if (!selectedProject || !collectionGroups) return [];
    return collectionGroups
      .filter((group) => group.tasks.length + group.chats.length > 0)
      .map((group) => getCollectionGroupScopeKey(selectedProject.encodedDir, group));
  }, [collectionGroups, selectedProject]);

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

  return (
    <div className="h-full flex flex-col bg-(--board-bg)" data-testid="sidebar">
      {isInitialized && !isAllMode && collectionGroups && selectedProject ? (
        <ProjectListContextHeader
          project={selectedProject}
          hasExpandableGroups={collectionGroupScopeKeys.length > 0}
          allGroupsCollapsed={areAllCollectionGroupsCollapsed}
          expandAllLabel={t('sidebar.expandAll')}
          collapseAllLabel={t('sidebar.collapseAll')}
          onExpandAll={() => setAllCollectionGroupsCollapsed(false)}
          onCollapseAll={() => setAllCollectionGroupsCollapsed(true)}
        />
      ) : null}
      <ScrollArea
        className="min-h-0 flex-1 px-1 py-2 [scrollbar-gutter:stable]"
        data-testid="sidebar-scroll-area"
      >
        {!isInitialized ? (
          <SidebarLoadingState label={t('common.loading')} />
        ) : isAllMode ? (
          <AllProjectsList
            activeSessionId={selectionSessionId}
            onSessionClick={handleSessionClick}
            onSessionDoubleClick={handleSessionDoubleClick}
            onSessionArchive={handleTaskArchive}
            onSessionRename={handleTaskRename}
            onSessionDelete={handleTaskDelete}
            onSessionOpenInNewTab={handleTaskOpenInNewTab}
            onSessionGenerateTitle={handleTaskGenerateTitle}
            onSessionMoveToProject={handleTaskMoveToProject}
            onSessionStopProcess={handleTaskStopProcess}
          />
        ) : collectionGroups && selectedProject ? (
          <>
            {collectionGroups.map((group, groupIdx) => {
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
                  onTaskRename={(taskId, title) => useTaskStore.getState().updateTask(taskId, { title })}
                  onTaskDelete={(taskId) => useTaskStore.getState().deleteTask(taskId)}
                  onTaskStatusChange={handleTaskStatusChangeById}
                  onSessionRename={handleTaskRename}
                  onSessionDelete={handleTaskDelete}
                  onSessionArchive={handleTaskArchive}
                  onSessionOpenInNewTab={handleTaskOpenInNewTab}
                  onSessionGenerateTitle={handleTaskGenerateTitle}
                  onSessionMoveToProject={handleTaskMoveToProject}
                  onSessionStopProcess={handleTaskStopProcess}
                />
              );
            })}
            <SidebarAddCollectionControl
              isAdding={addingCollection}
              value={newCollectionLabel}
              onStartAdding={() => setAddingCollection(true)}
              onValueChange={setNewCollectionLabel}
              onSubmit={handleAddCollection}
              onCancel={resetCollectionComposer}
            />
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
