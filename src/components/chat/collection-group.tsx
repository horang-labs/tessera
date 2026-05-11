'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { ChevronRight, Plus, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { collectionGroupContainsSession } from '@/lib/chat/build-collection-groups';
import {
  getCollectionSessionSnapshots,
  getPrioritizedCollectionIndicatorStatus,
} from '@/lib/chat/collection-status-indicator';
import { getProviderSessionRuntimeConfig } from '@/lib/settings/provider-defaults';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { useBoardStore } from '@/stores/board-store';
import {
  selectAnyAwaitingUserPrompt,
  selectAnyTurnInFlight,
  useChatStore,
} from '@/stores/chat-store';
import { useCollectionStore } from '@/stores/collection-store';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTabStore } from '@/stores/tab-store';
import { useTaskStore } from '@/stores/task-store';
import type { UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import type { TaskEntity } from '@/types/task-entity';
import { useI18n } from '@/lib/i18n';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';
import {
  ChatItemRow,
  CollectionContextMenu,
  CollectionHeaderMenu,
  TaskItemRow,
  type ContextMenuState,
} from './collection-group-sections';
import { DeleteTaskDialog } from './delete-task-dialog';
import { ItemStatusIndicator } from './work-item-primitives';

async function addSessionToTask(task: TaskEntity, requestedProviderId?: string) {
  try {
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

    const sessionResponse = await fetchWithClientId('/api/sessions', {
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
    if (!sessionResponse.ok) throw new Error('Failed to create session');

    const sessionData = await sessionResponse.json();
    const newSessionId = sessionData.sessionId || sessionData.id;
    if (!newSessionId) throw new Error('No session ID returned');

    const newSession: UnifiedSession = {
      id: newSessionId,
      title: sessionData.title || 'New Session',
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
      provider: sessionData.provider,
      model: sessionData.model,
      reasoningEffort: sessionData.reasoningEffort,
      serviceTier: sessionData.serviceTier,
    };

    useSessionStore.getState().addSession(newSession);
    useChatStore.getState().loadHistory(newSessionId, []);

    const latestPanelState = usePanelStore.getState();
    latestPanelState.assignSession(
      selectActiveTab(latestPanelState)?.activePanelId ?? '',
      newSessionId,
    );
    useTabStore.getState().syncTabProjectFromSession(latestPanelState.activeTabId, newSessionId);

    await useTaskStore.getState().loadTasks(task.projectId);
    await useSessionStore.getState().loadProjects();
  } catch (error) {
    console.error('Failed to add session to task:', error);
  }
}

export interface CollectionGroupProps {
  collection: Collection | null;
  contextMenuCollections?: Collection[];
  projectId: string;
  projectDir: string;
  tasks: TaskEntity[];
  chats: UnifiedSession[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick?: (session: UnifiedSession) => void;
  activeSessionId: string | null;
  isDragActive: boolean;
  isDragOver: boolean;
  isGroupDragging: boolean;
  isGroupDragOver: boolean;
  onItemDragStart: (
    type: 'task' | 'chat',
    id: string,
    collectionId: string | null,
    projectId: string,
    e: React.DragEvent,
  ) => void;
  onItemDragEnd: (e: React.DragEvent) => void;
  onCollectionDragOver: (collectionScopeId: string, projectId: string, e: React.DragEvent) => void;
  onCollectionDragLeave: (collectionScopeId: string, projectId: string, e: React.DragEvent) => void;
  onCollectionDrop: (collectionId: string | null, projectId: string, e: React.DragEvent) => void;
  onItemDragOverItem: (
    targetId: string,
    collectionScopeId: string,
    targetType: 'task' | 'chat',
    projectId: string,
    e: React.DragEvent,
  ) => void;
  dropIndicator: { targetId: string; position: 'before' | 'after' } | null;
  onGroupDragStart: (
    groupScopeId: string,
    collectionId: string | null,
    projectId: string,
    e: React.DragEvent,
  ) => void;
  onGroupDragEnd: (e: React.DragEvent) => void;
  onGroupDragOver: (e: React.DragEvent) => void;
  onGroupDragLeave: (e: React.DragEvent) => void;
  onGroupDrop: (e: React.DragEvent) => void;
  onTaskRename?: (taskId: string, newTitle: string) => void;
  onTaskDelete?: (taskId: string) => void;
  onSessionRename?: (sessionId: string, newTitle: string) => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionArchive?: (sessionId: string) => void;
  onSessionOpenInNewTab?: (sessionId: string) => void;
  onSessionGenerateTitle?: (sessionId: string) => void;
  onSessionMoveToProject?: (sessionId: string) => void;
  onSessionStopProcess?: (sessionId: string) => void;
  onTaskStatusChange?: (taskId: string, status: string) => void;
  disableDnd?: boolean;
  allowPanelSessionDnd?: boolean;
  hideHeader?: boolean;
}

export const CollectionGroup = memo(function CollectionGroup({
  collection,
  contextMenuCollections,
  projectId,
  projectDir,
  tasks,
  chats,
  collapsed,
  onToggleCollapse,
  onSessionClick,
  onSessionDoubleClick,
  activeSessionId,
  isDragActive,
  isDragOver,
  isGroupDragging,
  isGroupDragOver,
  onItemDragStart,
  onItemDragEnd,
  onCollectionDragOver,
  onCollectionDragLeave,
  onCollectionDrop,
  onItemDragOverItem,
  dropIndicator,
  onGroupDragStart,
  onGroupDragEnd,
  onGroupDragOver,
  onGroupDragLeave,
  onGroupDrop,
  onTaskRename,
  onTaskDelete,
  onSessionRename,
  onSessionDelete,
  onSessionArchive,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionMoveToProject,
  onSessionStopProcess,
  onTaskStatusChange,
  disableDnd = false,
  allowPanelSessionDnd = false,
  hideHeader = false,
}: CollectionGroupProps) {
  const { t } = useI18n();
  const isUncategorized = collection === null;
  const collectionLabel = collection?.label ?? t('task.creation.noCollection');
  const totalItems = tasks.length + chats.length;
  const collectionId = collection?.id ?? '__uncategorized';
  const collectionScopeId = `${projectId}::${collectionId}`;
  const justDroppedId = useBoardStore((state) => state.justDroppedId);
  const draggingItemId = useBoardStore((state) => state.draggingCollectionItem?.id);
  const setCollectionCollapsed = useBoardStore((state) => state.setCollectionCollapsed);
  const isEmpty = totalItems === 0;
  const isCollapsed = isEmpty || (!hideHeader && collapsed);
  const collectionSessionSnapshots = useMemo(
    () => getCollectionSessionSnapshots(tasks, chats),
    [tasks, chats],
  );
  const collectionSessionIds = useMemo(
    () => collectionSessionSnapshots.map((session) => session.id),
    [collectionSessionSnapshots],
  );
  const hasLiveSession = useSessionStore((state) =>
    collectionSessionSnapshots.some((snapshot) => {
      for (const project of state.projects) {
        const liveSession = project.sessions.find((session) => session.id === snapshot.id);
        if (liveSession) return liveSession.isRunning;
      }

      return snapshot.isRunning;
    }),
  );
  const hasProcessingSession = useChatStore(selectAnyTurnInFlight(collectionSessionIds));
  const hasUnreadSession = useSessionStore((state) =>
    collectionSessionSnapshots.some((snapshot) => {
      if (snapshot.id === activeSessionId) return false;

      for (const project of state.projects) {
        const liveSession = project.sessions.find((session) => session.id === snapshot.id);
        if (liveSession) return (liveSession.unreadCount ?? 0) > 0;
      }

      return (snapshot.unreadCount ?? 0) > 0;
    }),
  );
  const hasAwaitingUserSession = useChatStore(selectAnyAwaitingUserPrompt(collectionSessionIds));
  const collectionIndicatorStatus = getPrioritizedCollectionIndicatorStatus({
    hasLiveSession,
    hasProcessingSession,
    hasUnreadSession,
    hasAwaitingUserSession,
  });

  useEffect(() => {
    if (hideHeader) return;
    if (activeSessionId && collapsed && collectionGroupContainsSession({ tasks, chats }, activeSessionId)) {
      setCollectionCollapsed(collectionScopeId, false);
    }
    // Only trigger on activeSessionId changes — manual collapse must not be overridden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ type: 'task' | 'chat'; id: string } | null>(null);
  const [isEditingCollection, setIsEditingCollection] = useState(false);
  const [editingLabel, setEditingLabel] = useState('');
  const [isQuickCreateOpen, setIsQuickCreateOpen] = useState(false);
  const [taskIdToDelete, setTaskIdToDelete] = useState<string | null>(null);

  const editInputRef = useRef<HTMLInputElement>(null);
  const quickCreateTriggerRef = useRef<HTMLButtonElement>(null);

  const openItemContextMenu = useCallback(
    (
      event: React.MouseEvent,
      type: 'chat' | 'task',
      id: string,
      currentCollectionId: string | null,
      isSubSession?: boolean,
    ) => {
      const isRunning =
        type === 'chat'
          ? useSessionStore.getState().getSession(id)?.isRunning ?? false
          : useTaskStore.getState().getTask(id)?.sessions.some((session) => session.isRunning) ?? false;

      const currentStatus =
        type === 'task' ? (useTaskStore.getState().getTask(id)?.workflowStatus ?? 'todo') : undefined;

      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        type,
        targetId: id,
        currentCollectionId,
        isRunning,
        isSubSession,
        currentStatus,
      });
    },
    [],
  );

  const startEditingCollection = useCallback(() => {
    if (!collection) return;
    setEditingLabel(collection.label);
    setIsEditingCollection(true);
  }, [collection]);

  const finishItemRename = useCallback(() => setRenamingItem(null), []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const commitCollectionRename = useCallback(() => {
    if (!collection) return;

    const trimmedLabel = editingLabel.trim();
    setIsEditingCollection(false);

    if (trimmedLabel && trimmedLabel !== collection.label) {
      useCollectionStore.getState().updateCollection(collection.id, trimmedLabel, collection.color);
    }
  }, [collection, editingLabel]);

  useEffect(() => {
    if (isEditingCollection && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [isEditingCollection]);

  const handleContextMenuRename = useCallback(() => {
    if (!contextMenu) return;
    setRenamingItem({ type: contextMenu.type, id: contextMenu.targetId });
  }, [contextMenu]);

  const handleContextMenuDelete = useCallback(() => {
    if (!contextMenu) return;

    if (contextMenu.type === 'task') {
      setTaskIdToDelete(contextMenu.targetId);
      return;
    }

    onSessionDelete?.(contextMenu.targetId);
  }, [contextMenu, onSessionDelete]);

  const handleContextMenuArchive = useCallback(() => {
    if (!contextMenu || contextMenu.isSubSession) return;

    if (contextMenu.type === 'task') {
      void useTaskStore.getState().toggleTaskArchive(contextMenu.targetId, true);
      return;
    }

    onSessionArchive?.(contextMenu.targetId);
  }, [contextMenu, onSessionArchive]);

  const handleContextMenuGenerateTitle = useCallback(() => {
    if (!contextMenu || !onSessionGenerateTitle) return;

    const targetSessionId =
      contextMenu.type === 'task'
        ? useTaskStore.getState().getTask(contextMenu.targetId)?.sessions[0]?.id
        : contextMenu.targetId;

    if (targetSessionId) {
      onSessionGenerateTitle(targetSessionId);
    }
  }, [contextMenu, onSessionGenerateTitle]);

  const handleContextMenuStopProcess = useCallback(() => {
    if (!contextMenu || !onSessionStopProcess) return;

    if (contextMenu.type === 'chat') {
      onSessionStopProcess(contextMenu.targetId);
      return;
    }

    const task = useTaskStore.getState().getTask(contextMenu.targetId) ?? tasks.find((item) => item.id === contextMenu.targetId);
    for (const session of task?.sessions ?? []) {
      const liveSession = useSessionStore.getState().getSession(session.id);
      if (liveSession?.isRunning ?? session.isRunning) {
        onSessionStopProcess(session.id);
      }
    }
  }, [contextMenu, onSessionStopProcess, tasks]);

  return (
    <div
      className={cn(
        'relative mt-0.5 first:mt-0',
        isGroupDragging && 'opacity-40',
        isGroupDragOver && 'rounded-lg ring-2 ring-(--accent) ring-inset',
      )}
      onDragOver={(event) => {
        if (disableDnd) return;
        onCollectionDragOver(collectionScopeId, projectId, event);
        onGroupDragOver(event);
      }}
      onDragLeave={(event) => {
        if (disableDnd) return;
        onCollectionDragLeave(collectionScopeId, projectId, event);
        onGroupDragLeave(event);
      }}
      onDrop={(event) => {
        if (disableDnd) return;
        onCollectionDrop(collection?.id ?? null, projectId, event);
        onGroupDrop(event);
      }}
      role="region"
      aria-label={collectionLabel}
      data-testid={`collection-group-${collectionId}`}
    >
      {!hideHeader && (
        <div
          draggable={!disableDnd && !isUncategorized}
          onDragStart={
            !disableDnd && !isUncategorized
              ? (event) => onGroupDragStart(collectionScopeId, collection?.id ?? null, projectId, event)
              : undefined
          }
          onDragEnd={!disableDnd && !isUncategorized ? onGroupDragEnd : undefined}
          className={cn(
            'group/collection relative mx-1 flex select-none items-center gap-2 rounded-lg px-3 py-1.5 transition-colors duration-150',
            !isEmpty && 'cursor-pointer',
            !disableDnd && !isUncategorized && 'cursor-grab active:cursor-grabbing',
            'hover:bg-(--sidebar-hover)/60',
            !isCollapsed && 'bg-(--sidebar-hover)/30',
            isUncategorized && 'opacity-70',
            isDragOver && !isGroupDragOver && 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]',
          )}
          onClick={isEmpty ? undefined : onToggleCollapse}
          data-testid={`collection-header-${collectionId}`}
        >
        <div className="relative h-3 w-3 shrink-0">
          {isEmpty ? (
            <Tag className="absolute inset-0 h-3 w-3 text-(--text-muted)" />
          ) : (
            <>
              <Tag className="absolute inset-0 h-3 w-3 text-(--text-muted) transition-opacity duration-150 group-hover/collection:opacity-0" />
              <ChevronRight
                className={cn(
                  'absolute inset-0 h-3 w-3 text-(--text-muted) opacity-0 transition-all duration-150 group-hover/collection:opacity-100',
                  !isCollapsed && 'rotate-90',
                )}
              />
            </>
          )}
          {collectionIndicatorStatus && isCollapsed && (
            <span data-testid={`collection-status-indicator-${collectionId}`}>
              <ItemStatusIndicator
                isProcessing={collectionIndicatorStatus === 'processing'}
                isAwaitingUser={collectionIndicatorStatus === 'awaiting-user'}
                hasUnread={collectionIndicatorStatus === 'unread'}
                isRunning={collectionIndicatorStatus === 'running'}
                placement="corner"
                surface="sidebar"
              />
            </span>
          )}
        </div>

        {isEditingCollection ? (
          <input
            ref={editInputRef}
            value={editingLabel}
            onChange={(event) => setEditingLabel(event.target.value)}
            onBlur={commitCollectionRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitCollectionRename();
              if (event.key === 'Escape') setIsEditingCollection(false);
            }}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 rounded border border-(--accent) bg-transparent px-1 py-0.5 text-[0.8125rem] font-medium leading-snug outline-none"
            style={{ color: 'var(--sidebar-text-active)' }}
          />
        ) : (
          <span
            className="flex flex-1 items-center gap-1.5 leading-snug"
            style={{ color: 'var(--sidebar-text-active)' }}
          >
            <span className="truncate text-[0.8125rem] font-medium">{collectionLabel}</span>
            <span className="tabular-nums text-[0.625rem] font-normal text-(--text-muted) opacity-50">
              {totalItems}
            </span>
          </span>
        )}

        <div
          className={cn(
            'flex items-center gap-0.5 transition-opacity duration-150',
            isQuickCreateOpen ? 'opacity-100' : 'opacity-0 group-hover/collection:opacity-100',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            ref={quickCreateTriggerRef}
            type="button"
            onClick={() => setIsQuickCreateOpen((prev) => !prev)}
            className={cn(
              'rounded p-0.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
              isQuickCreateOpen && 'bg-(--sidebar-hover) text-(--sidebar-text-active)',
            )}
            aria-label="Create in collection"
            data-testid={`collection-quick-create-toggle-${collectionId}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {!isUncategorized && (
            <CollectionHeaderMenu collectionId={collectionId} onEdit={startEditingCollection} />
          )}
        </div>
        </div>
      )}

      {!hideHeader && isQuickCreateOpen && (
        <CollectionQuickCreateSheet
          collection={collection}
          projectId={projectId}
          projectDir={projectDir}
          anchorRef={quickCreateTriggerRef}
          onClose={() => setIsQuickCreateOpen(false)}
        />
      )}

      {!isCollapsed && (
        <div
          className={cn(hideHeader ? 'space-y-0.5' : 'ml-4 space-y-0.5')}
        >
          {tasks.map((task) => (
            <TaskItemRow
              key={task.id}
              task={task}
              activeSessionId={activeSessionId}
              onSessionClick={onSessionClick}
              onSessionDoubleClick={onSessionDoubleClick}
              onContextMenu={openItemContextMenu}
              isDragging={draggingItemId === task.id}
              isJustDropped={justDroppedId === task.id}
              dropIndicatorBefore={dropIndicator?.targetId === task.id && dropIndicator.position === 'before'}
              dropIndicatorAfter={dropIndicator?.targetId === task.id && dropIndicator.position === 'after'}
              onDragStart={(event) => onItemDragStart('task', task.id, task.collectionId ?? null, projectId, event)}
              onDragEnd={onItemDragEnd}
              onDragOverItem={(event) => onItemDragOverItem(task.id, collectionScopeId, 'task', projectId, event)}
              onRename={onTaskRename}
              onSessionRename={onSessionRename}
              renamingSessionId={renamingItem?.type === 'chat' ? renamingItem.id : null}
              isRenameRequested={renamingItem?.type === 'task' && renamingItem.id === task.id}
              onRenameComplete={finishItemRename}
              onAddSession={(providerId) => addSessionToTask(task, providerId)}
              onStopProcess={onSessionStopProcess}
              disableDnd={disableDnd}
              allowPanelSessionDnd={allowPanelSessionDnd}
            />
          ))}

          {chats.length > 0 && (
            <div className="relative space-y-0.5">
              {tasks.length > 0 && (
                <div className="pointer-events-none absolute -top-px left-4 right-4 h-px bg-(--divider) opacity-20" />
              )}
              {chats.map((session) => (
                <ChatItemRow
                  key={session.id}
                  session={session}
                  activeSessionId={activeSessionId}
                  onSessionClick={onSessionClick}
                  onSessionDoubleClick={onSessionDoubleClick}
                  onContextMenu={openItemContextMenu}
                  isDragging={draggingItemId === session.id}
                  isJustDropped={justDroppedId === session.id}
                  dropIndicatorBefore={dropIndicator?.targetId === session.id && dropIndicator.position === 'before'}
                  dropIndicatorAfter={dropIndicator?.targetId === session.id && dropIndicator.position === 'after'}
                  onDragStart={(event) => onItemDragStart('chat', session.id, session.collectionId ?? null, projectId, event)}
                  onDragEnd={onItemDragEnd}
                  onDragOverItem={(event) => onItemDragOverItem(session.id, collectionScopeId, 'chat', projectId, event)}
                  onRename={onSessionRename}
                  isRenameRequested={renamingItem?.type === 'chat' && renamingItem.id === session.id}
                  onRenameComplete={finishItemRename}
                  onArchive={onSessionArchive}
                  onStopProcess={onSessionStopProcess}
                  disableDnd={disableDnd}
                  allowPanelSessionDnd={allowPanelSessionDnd}
                />
              ))}
            </div>
          )}

          {totalItems === 0 && (
            <div
              className={cn(
                'px-3 py-2 text-center text-[0.6875rem] font-normal text-(--text-muted) transition-opacity duration-200',
                isDragActive ? 'opacity-35' : 'opacity-0',
                isDragOver && 'text-(--accent) opacity-70',
              )}
            >
              Drop here
            </div>
          )}
        </div>
      )}


      {contextMenu && (
        <CollectionContextMenu
          menu={contextMenu}
          collections={contextMenuCollections}
          onClose={closeContextMenu}
          onRename={handleContextMenuRename}
          onDelete={handleContextMenuDelete}
          onArchive={!contextMenu.isSubSession ? handleContextMenuArchive : undefined}
          onOpenInNewTab={contextMenu.type === 'chat' ? () => onSessionOpenInNewTab?.(contextMenu.targetId) : undefined}
          onGenerateTitle={onSessionGenerateTitle ? handleContextMenuGenerateTitle : undefined}
          onMoveToProject={contextMenu.type === 'chat' && !contextMenu.isSubSession ? () => onSessionMoveToProject?.(contextMenu.targetId) : undefined}
          onStopProcess={contextMenu.isRunning ? handleContextMenuStopProcess : undefined}
          onStatusChange={
            contextMenu.type === 'task' && !contextMenu.isSubSession && onTaskStatusChange
              ? (status) => onTaskStatusChange(contextMenu.targetId, status)
              : undefined
          }
        />
      )}

      {taskIdToDelete && (
        <DeleteTaskDialog
          task={tasks.find((task) => task.id === taskIdToDelete) ?? null}
          isOpen={taskIdToDelete !== null}
          onConfirm={async () => {
            onTaskDelete?.(taskIdToDelete);
            setTaskIdToDelete(null);
          }}
          onCancel={() => setTaskIdToDelete(null)}
        />
      )}
    </div>
  );
});
