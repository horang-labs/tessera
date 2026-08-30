'use client';

import { Fragment, memo, useRef, useCallback, useMemo } from 'react';
import type React from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getProjectColor } from '@/lib/constants/project-strip';
import {
  getKanbanMultiSessionDragIds,
  setPanelSessionDragData,
} from '@/lib/dnd/panel-session-drag';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import { useBoardStore } from '@/stores/board-store';
import { useSelectionStore } from '@/stores/selection-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { TASK_DND_MIME, TASK_ENTITY_DND_MIME, TASK_MULTI_DND_MIME } from '@/types/task';
import { WORKFLOW_STATUS_CONFIG } from '@/types/task-entity';
import type { WorkflowStatus, TaskEntity } from '@/types/task-entity';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import { CollectionQuickCreateSheet } from '@/components/chat/collection-quick-create-sheet';
import { KanbanChatCard, KanbanTaskCard } from './kanban-card';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { captureTelemetryEvent } from '@/lib/telemetry/client';

type KanbanQuickCreateColumn = 'chat' | WorkflowStatus;
export type KanbanColumnInteractionMode = 'editable' | 'filtered';

function setPanelOnlySessionDragData(
  e: React.DragEvent,
  sessionId: string | null | undefined,
): void {
  setPanelSessionDragData(e.dataTransfer, sessionId);
  e.dataTransfer.effectAllowed = 'move';
}

function KanbanQuickCreateButton({
  project,
  column,
  collection,
  collections,
  isOpen,
  onToggle,
  onClose,
  testId,
}: {
  project: ProjectGroup | null;
  column: KanbanQuickCreateColumn;
  collection: Collection | null;
  collections: Collection[];
  isOpen: boolean;
  onToggle: (column: KanbanQuickCreateColumn, projectId: string) => void;
  onClose: () => void;
  testId: string;
}) {
  const { t } = useI18n();
  const addMenuRef = useRef<HTMLDivElement>(null);
  const isChatColumn = column === 'chat';
  // Peek 모드에서는 새로 만든 세션도 즉시 Peek로 열어준다 — 그러지 않으면
  // 카드만 생기고 사용자는 방금 만든 세션을 다시 클릭해야 한다.
  const handleSessionCreated = useCallback((sessionId: string) => {
    if (useSettingsStore.getState().settings.kanbanSessionOpenMode !== 'peek') return;
    useBoardStore.getState().openSessionPeek(sessionId);
  }, []);

  return (
    <div
      ref={addMenuRef}
      className="relative shrink-0"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        {...telemetryClickAttributes('board.column.add_chat', 'workspace_board')}
        type="button"
        disabled={project === null}
        title={project === null ? t('task.board.selectProjectToCreate') : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (project) onToggle(column, project.encodedDir);
        }}
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-[5px]',
          'border-none bg-transparent transition-all',
          'text-(--text-muted) hover:text-(--accent-light)',
          'hover:bg-[color-mix(in_srgb,var(--accent)_15%,transparent)]',
          'cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-(--text-muted)',
        )}
        aria-label={isChatColumn ? t('task.newChat.label') : t('task.newChat.newTask')}
        data-testid={testId}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {isOpen && project && (
        <CollectionQuickCreateSheet
          collection={collection}
          collections={collections}
          projectDir={project.decodedPath}
          projectId={project.encodedDir}
          initialMode={isChatColumn ? 'chat' : 'task'}
          availableModes={isChatColumn ? ['chat'] : ['task']}
          workflowStatus={isChatColumn ? undefined : column}
          allowCollectionSelection={collection === null}
          scopeId={`kanban-${column}`}
          anchorRef={addMenuRef}
          onSessionCreated={handleSessionCreated}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function PortfolioProjectHeader({
  project,
  count,
  column,
  collection,
  collections,
  isQuickCreateOpen,
  interactionMode,
  onToggleQuickCreate,
  onCloseQuickCreate,
}: {
  project: ProjectGroup;
  count: number;
  column: KanbanQuickCreateColumn;
  collection: Collection | null;
  collections: Collection[];
  isQuickCreateOpen: boolean;
  interactionMode: KanbanColumnInteractionMode;
  onToggleQuickCreate: (column: KanbanQuickCreateColumn, projectId: string) => void;
  onCloseQuickCreate: () => void;
}) {
  return (
    <div
      className="sticky top-0 z-10 -mx-0.5 flex items-center gap-1.5 bg-(--board-bg) px-1 py-1.5"
      data-testid={`kanban-project-group-${project.encodedDir}`}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: getProjectColor(project.displayName) }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold text-(--text-secondary)">
        {project.displayName}
      </span>
      <span className="text-[0.625rem] tabular-nums text-(--text-muted)">{count}</span>
      {interactionMode === 'editable' ? (
        <KanbanQuickCreateButton
          project={project}
          column={column}
          collection={collection}
          collections={collections}
          isOpen={isQuickCreateOpen}
          onToggle={onToggleQuickCreate}
          onClose={onCloseQuickCreate}
          testId={`kanban-project-add-${column}-${project.encodedDir}`}
        />
      ) : null}
    </div>
  );
}

// ============================================================
// KanbanChatColumn
// ============================================================

interface KanbanChatColumnProps {
  chats: UnifiedSession[];
  collection: Collection | null;
  collections: Collection[];
  collectionsByProject: Record<string, Collection[]>;
  projects: ProjectGroup[];
  groupByProject: boolean;
  createProject: ProjectGroup | null;
  activeSessionId: string | null;
  quickCreateProjectId: string | null;
  interactionMode: KanbanColumnInteractionMode;
  onCardDragStart: (sessionId: string, e: React.DragEvent) => void;
  onCardDragEnd: (e: React.DragEvent) => void;
  onCardDragOver: (sessionId: string, status: string, e: React.DragEvent) => void;
  onColumnDragOver: (status: string, e: React.DragEvent) => void;
  onColumnDragLeave: (status: string, e: React.DragEvent) => void;
  onColumnDrop: (status: string, e: React.DragEvent) => void;
  onCardClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onCardDoubleClick: (session: UnifiedSession) => void;
  onToggleQuickCreate: (column: KanbanQuickCreateColumn, projectId: string) => void;
  onCloseQuickCreate: () => void;
  // Context menu actions
  onCardStatusChange?: (taskId: string, status: string) => void;
  onCardArchive?: (taskId: string) => void;
  onCardUnarchive?: (taskId: string) => void;
  onCardRename?: (taskId: string, newTitle: string) => void;
  onCardDelete?: (taskId: string) => void;
  onCardOpenInNewTab?: (taskId: string) => void;
  onCardGenerateTitle?: (taskId: string) => void;
  onCardMoveToCollection?: (taskId: string, collectionId: string | null) => void;
  onCardStopProcess?: (taskId: string) => void;
}

export const KanbanChatColumn = memo(function KanbanChatColumn({
  chats,
  collection,
  collections,
  collectionsByProject,
  projects,
  groupByProject,
  createProject,
  activeSessionId,
  quickCreateProjectId,
  interactionMode,
  onCardDragStart,
  onCardDragEnd,
  onCardDragOver,
  onColumnDragOver,
  onColumnDragLeave,
  onColumnDrop,
  onCardClick,
  onCardDoubleClick,
  onToggleQuickCreate,
  onCloseQuickCreate,
  onCardStatusChange,
  onCardArchive,
  onCardUnarchive,
  onCardRename,
  onCardDelete,
  onCardOpenInNewTab,
  onCardGenerateTitle,
  onCardMoveToCollection,
  onCardStopProcess,
}: KanbanChatColumnProps) {
  const { t } = useI18n();
  const isEditable = interactionMode === 'editable';
  const isDragOver = useBoardStore((s) =>
    isEditable && s.dragOverStatus === 'chat' && s.draggingTaskId !== null
  );
  const dropIndicator = useBoardStore((s) => s.dropIndicator);
  const chatGroups = useMemo(() => {
    if (!groupByProject) {
      return [{ project: null, chats }];
    }
    return projects.map((project) => ({
      project,
      chats: chats.filter((session) => session.projectDir === project.encodedDir),
    }));
  }, [chats, groupByProject, projects]);

  return (
    <div
      className="w-[268px] shrink-0 flex flex-col h-full"
      data-testid="kanban-column"
      data-status="chat"
    >
      {/* Column header -- muted style with left border accent */}
      <div className={cn(
        'flex items-center gap-2 mx-1 px-2.5 pt-1 pb-2.5 shrink-0 border-b',
        'border-[color-mix(in_srgb,var(--text-muted)_15%,transparent)]',
      )}>
        {/* Accent color dot */}
        <div
          className="w-2 h-2 rounded-full shrink-0 opacity-60"
          style={{ background: 'var(--text-muted)' }}
        />
        {/* Status label */}
        <span className="flex-1 text-[0.75rem] font-bold uppercase tracking-wider truncate text-(--text-muted)">
          {t('task.status.chat')}
        </span>
        {/* Task count pill */}
        <span className="text-[0.625rem] font-semibold tabular-nums px-[7px] py-px rounded-[10px] bg-(--board-count-bg) text-(--board-count-text)">
          {chats.length}
        </span>
        {!groupByProject && isEditable ? (
          <KanbanQuickCreateButton
            project={createProject}
            column="chat"
            collection={collection}
            collections={collections}
            isOpen={quickCreateProjectId === createProject?.encodedDir}
            onToggle={onToggleQuickCreate}
            onClose={onCloseQuickCreate}
            testId="kanban-column-add-btn"
          />
        ) : null}
      </div>

      {/* Cards */}
      <div
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden',
          'px-2 pb-2.5 pt-2.5',
          'min-h-[80px]',
          isDragOver && 'rounded-[14px] bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]',
        )}
        data-testid="kanban-column-cards"
        onDragOver={isEditable ? (e) => onColumnDragOver('chat', e) : undefined}
        onDragLeave={isEditable ? (e) => onColumnDragLeave('chat', e) : undefined}
        onDrop={isEditable ? (e) => onColumnDrop('chat', e) : undefined}
      >
        <div className="flex flex-col gap-2.5">
          {chatGroups.map((group, groupIndex) => (
            <Fragment key={group.project?.encodedDir ?? `single-${groupIndex}`}>
              {group.project && (
                <PortfolioProjectHeader
                  project={group.project}
                  count={group.chats.length}
                  column="chat"
                  collection={collection}
                  collections={collectionsByProject[group.project.encodedDir] ?? collections}
                  isQuickCreateOpen={quickCreateProjectId === group.project.encodedDir}
                  interactionMode={interactionMode}
                  onToggleQuickCreate={onToggleQuickCreate}
                  onCloseQuickCreate={onCloseQuickCreate}
                />
              )}
              <div className="flex flex-col gap-1.5">
                {group.chats.map((session) => (
                  <KanbanChatCard
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    dropIndicatorBefore={dropIndicator?.targetSessionId === session.id && dropIndicator.position === 'before'}
                    dropIndicatorAfter={dropIndicator?.targetSessionId === session.id && dropIndicator.position === 'after'}
                    dragEnabled
                    onDragStart={isEditable
                      ? (e) => onCardDragStart(session.id, e)
                      : (e) => setPanelOnlySessionDragData(e, session.id)}
                    onDragEnd={isEditable ? onCardDragEnd : undefined}
                    onDragOverItem={isEditable ? (e) => onCardDragOver(session.id, 'chat', e) : undefined}
                    onClick={(e) => onCardClick(session, e)}
                    onDoubleClick={() => onCardDoubleClick(session)}
                    onStatusChange={onCardStatusChange}
                    onArchive={onCardArchive}
                    onUnarchive={onCardUnarchive}
                    onRename={onCardRename}
                    onDelete={onCardDelete}
                    onOpenInNewTab={onCardOpenInNewTab}
                    onGenerateTitle={onCardGenerateTitle}
                    onMoveToCollection={onCardMoveToCollection}
                    onStopProcess={onCardStopProcess}
                    collections={collectionsByProject[session.projectDir] ?? collections}
                  />
                ))}
              </div>
            </Fragment>
          ))}
        </div>

        {chats.length === 0 && isEditable ? (
          <div className="flex items-center justify-center py-6 text-[0.6875rem] text-(--text-muted) opacity-40">
            {t('task.board.emptyColumn')}
          </div>
        ) : null}
      </div>
    </div>
  );
});

// ============================================================
// KanbanWorkflowColumn
// ============================================================

interface KanbanWorkflowColumnProps {
  status: WorkflowStatus;
  /** The Project View currently on screen; null only for unfiltered All Projects. */
  projectViewId: string | null;
  tasks: TaskEntity[];
  chats: UnifiedSession[];
  collection: Collection | null;
  collections: Collection[];
  collectionsByProject: Record<string, Collection[]>;
  projects: ProjectGroup[];
  groupByProject: boolean;
  createProject: ProjectGroup | null;
  activeSessionId: string | null;
  quickCreateProjectId: string | null;
  interactionMode: KanbanColumnInteractionMode;
  onToggleQuickCreate: (column: KanbanQuickCreateColumn, projectId: string) => void;
  onCloseQuickCreate: () => void;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick: (session: UnifiedSession) => void;
  onChatDragStart: (sessionId: string, e: React.DragEvent) => void;
  onChatDragEnd: (e: React.DragEvent) => void;
  onChatDragOver: (sessionId: string, status: string, e: React.DragEvent) => void;
  onAddSession?: (task: TaskEntity, providerId?: string, executionMode?: AgentExecutionMode) => void;
  onTaskContextMenu?: (task: TaskEntity, anchorRect: DOMRect) => void;
  onTaskRename?: (taskId: string, newTitle: string) => void;
  onChatArchive?: (sessionId: string) => void;
  onChatUnarchive?: (sessionId: string) => void;
  onChatStatusChange?: (sessionId: string, status: string) => void;
  onSessionRename?: (sessionId: string, newTitle: string) => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionOpenInNewTab?: (sessionId: string) => void;
  onSessionGenerateTitle?: (sessionId: string) => void;
  onSessionStopProcess?: (sessionId: string) => void;
  renamingTaskId?: string | null;
  onTaskRenameComplete?: (taskId: string) => void;
}

export const KanbanWorkflowColumn = memo(function KanbanWorkflowColumn({
  status,
  projectViewId,
  tasks,
  chats,
  collection,
  collections,
  collectionsByProject,
  projects,
  groupByProject,
  createProject,
  activeSessionId,
  quickCreateProjectId,
  interactionMode,
  onToggleQuickCreate,
  onCloseQuickCreate,
  onSessionClick,
  onSessionDoubleClick,
  onChatDragStart,
  onChatDragEnd,
  onChatDragOver,
  onAddSession,
  onTaskContextMenu,
  onTaskRename,
  onChatArchive,
  onChatUnarchive,
  onChatStatusChange,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionStopProcess,
  renamingTaskId,
  onTaskRenameComplete,
}: KanbanWorkflowColumnProps) {
  const { t } = useI18n();
  const isEditable = interactionMode === 'editable';
  const config = WORKFLOW_STATUS_CONFIG[status];
  const projectGroups = useMemo(() => {
    if (!groupByProject) {
      return [{ project: null, tasks, chats }];
    }
    return projects.map((project) => ({
      project,
      tasks: tasks.filter((task) => task.projectId === project.encodedDir),
      chats: chats.filter((session) => session.projectDir === project.encodedDir),
    }));
  }, [chats, groupByProject, projects, tasks]);

  const handlePanelOnlyTaskDragStart = useCallback((
    task: TaskEntity,
    e: React.DragEvent,
  ) => {
    setPanelOnlySessionDragData(e, task.sessions[0]?.id);
  }, []);

  const handlePanelOnlyChatDragStart = useCallback((
    session: UnifiedSession,
    e: React.DragEvent,
  ) => {
    setPanelOnlySessionDragData(e, session.id);
  }, []);
  // DnD: highlight when a task card is dragged over this column
  const isDragOver = useBoardStore((s) =>
    isEditable && s.dragOverStatus === status && s.draggingTaskId !== null
  );
  const dropIndicator = useBoardStore((s) => s.dropIndicator);

  const handleTaskDragOver = useCallback((taskId: string, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TASK_ENTITY_DND_MIME)) return;

    const draggingTaskId = useBoardStore.getState().draggingTaskId;
    if (!draggingTaskId || draggingTaskId === taskId) {
      if (useBoardStore.getState().dropIndicator) {
        useBoardStore.getState().setDropIndicator(null);
      }
      return;
    }

    const draggingTask = projectViewWorkspaceState.resolveTask(
      draggingTaskId,
      projectViewId ?? undefined,
    );
    const targetTask = projectViewWorkspaceState.resolveTask(
      taskId,
      projectViewId ?? undefined,
    );
    if (!draggingTask || !targetTask) {
      if (useBoardStore.getState().dropIndicator) {
        useBoardStore.getState().setDropIndicator(null);
      }
      return;
    }

    if (draggingTask.projectViewId !== targetTask.projectViewId) {
      if (useBoardStore.getState().dropIndicator) {
        useBoardStore.getState().setDropIndicator(null);
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'none';
      return;
    }

    if (draggingTask.workflowStatus !== status) {
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

    if (current?.targetSessionId !== taskId || current.position !== position) {
      useBoardStore.getState().setDropIndicator({ targetSessionId: taskId, position });
    }
  }, [projectViewId, status]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      !e.dataTransfer.types.includes(TASK_ENTITY_DND_MIME) &&
      !e.dataTransfer.types.includes(TASK_DND_MIME) &&
      !e.dataTransfer.types.includes(TASK_MULTI_DND_MIME)
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const currentOver = useBoardStore.getState().dragOverStatus;
    if (currentOver !== status) {
      useBoardStore.getState().setDragOver(status);
    }
  }, [status]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    const currentOver = useBoardStore.getState().dragOverStatus;
    if (currentOver === status) {
      useBoardStore.getState().setDragOver(null);
    }
    if (useBoardStore.getState().dropIndicator) {
      useBoardStore.getState().setDropIndicator(null);
    }
  }, [status]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (
      !e.dataTransfer.types.includes(TASK_ENTITY_DND_MIME) &&
      !e.dataTransfer.types.includes(TASK_DND_MIME) &&
      !e.dataTransfer.types.includes(TASK_MULTI_DND_MIME)
    ) {
      return;
    }

    const boardStore = useBoardStore.getState();
    const taskStore = useTaskStore.getState();
    const finishDrop = () => {
      boardStore.setDragging(null);
      boardStore.setDragOver(null);
      boardStore.setDropIndicator(null);
    };

    const taskId = e.dataTransfer.getData(TASK_ENTITY_DND_MIME);
    const chatSessionId = e.dataTransfer.getData(TASK_DND_MIME);
    const multiSessionIds = getKanbanMultiSessionDragIds(e.dataTransfer);
    const draggedTask = taskId
      ? projectViewWorkspaceState.resolveTask(taskId, projectViewId ?? undefined)
      : undefined;
    const sessionStore = useSessionStore.getState();
    const draggedChatSession = chatSessionId
      ? projectViewWorkspaceState.resolveSession(chatSessionId, projectViewId ?? undefined)
      : undefined;
    const sourceProjectId = draggedTask?.projectViewId ?? draggedChatSession?.projectDir;
    const visibleProjectIds = new Set(projects.map((project) => project.encodedDir));

    const isProjectInDropScope = (projectId: string) => {
      if (groupByProject) {
        return visibleProjectIds.has(projectId);
      }
      return !sourceProjectId || projectId === sourceProjectId;
    };

    if (multiSessionIds.length > 1) {
      const selectedTaskIds: string[] = [];
      const selectedChatIds: string[] = [];
      const seenTaskIds = new Set<string>();
      const seenChatIds = new Set<string>();

      for (const selectedSessionId of multiSessionIds) {
        const selectedTask = projectViewWorkspaceState.resolveTaskBySessionId(
          selectedSessionId,
          projectViewId ?? undefined,
        );
        if (selectedTask) {
          if (
            !isProjectInDropScope(selectedTask.projectViewId) ||
            seenTaskIds.has(selectedTask.id)
          ) {
            continue;
          }
          seenTaskIds.add(selectedTask.id);
          selectedTaskIds.push(selectedTask.id);
          continue;
        }

        const selectedSession = projectViewWorkspaceState.resolveSession(
          selectedSessionId,
          projectViewId ?? undefined,
        );
        if (
          !selectedSession ||
          selectedSession.taskId ||
          !isProjectInDropScope(selectedSession.projectDir) ||
          seenChatIds.has(selectedSession.id)
        ) {
          continue;
        }
        seenChatIds.add(selectedSession.id);
        selectedChatIds.push(selectedSession.id);
      }

      const movingTaskIds = selectedTaskIds.filter((selectedTaskId) => {
        const selectedTask = projectViewWorkspaceState.resolveTask(
          selectedTaskId,
          projectViewId ?? undefined,
        );
        return selectedTask && selectedTask.workflowStatus !== status;
      });
      const movingChatIds = selectedChatIds.filter((selectedChatId) => {
        const selectedSession = projectViewWorkspaceState.resolveSession(
          selectedChatId,
          projectViewId ?? undefined,
        );
        return selectedSession && selectedSession.workflowStatus !== status;
      });

      if (movingTaskIds.length + movingChatIds.length > 0) {
        for (const movingTaskId of movingTaskIds) {
          taskStore.updateTask(
            movingTaskId,
            { workflowStatus: status },
            projectViewId ?? undefined,
          );
        }
        for (const movingChatId of movingChatIds) {
          sessionStore.updateChatWorkflowStatus(
            movingChatId,
            status,
            projectViewId ?? undefined,
          );
        }
        boardStore.flashDrop(taskId || chatSessionId || movingTaskIds[0] || movingChatIds[0]);
        useSelectionStore.getState().clearSelection();
        if (movingTaskIds.length > 0) {
          void captureTelemetryEvent('workspace_item_moved', {
            item_type: 'task',
            move_kind: 'workflow_status',
            item_count: movingTaskIds.length,
          });
        }
        if (movingChatIds.length > 0) {
          void captureTelemetryEvent('workspace_item_moved', {
            item_type: 'chat',
            move_kind: 'workflow_status',
            item_count: movingChatIds.length,
          });
        }
        finishDrop();
        return;
      }
    }

    if (chatSessionId && e.dataTransfer.types.includes(TASK_DND_MIME)) {
      const session = draggedChatSession;
      const indicator = boardStore.dropIndicator;

      if (session && !session.taskId && session.workflowStatus === status && indicator) {
        const orderedIds = chats
          .filter((item) => item.projectDir === session.projectDir)
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((item) => item.id);
        const filtered = orderedIds.filter((id) => id !== chatSessionId);
        const targetIdx = filtered.indexOf(indicator.targetSessionId);

        if (targetIdx !== -1) {
          const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
          filtered.splice(insertIdx, 0, chatSessionId);
          sessionStore.reorderProjectSessions(
            projectViewId ?? session.projectDir,
            filtered,
          );
          boardStore.flashDrop(chatSessionId);
          void captureTelemetryEvent('workspace_item_moved', {
            item_type: 'chat',
            move_kind: 'reorder',
            item_count: 1,
          });
        }
      } else if (session && !session.taskId && session.workflowStatus !== status) {
        sessionStore.updateChatWorkflowStatus(
          chatSessionId,
          status,
          projectViewId ?? undefined,
        );
        boardStore.flashDrop(chatSessionId);
        void captureTelemetryEvent('workspace_item_moved', {
          item_type: 'chat',
          move_kind: 'workflow_status',
          item_count: 1,
        });
      }

      finishDrop();
      return;
    }

    if (taskId) {
      const task = draggedTask
        ?? projectViewWorkspaceState.resolveTask(taskId, projectViewId ?? undefined);
      const indicator = boardStore.dropIndicator;

      if (task && task.workflowStatus === status && indicator) {
        const orderedIds = tasks
          .filter((item) => item.projectViewId === task.projectViewId)
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((item) => item.id);
        const filtered = orderedIds.filter((id) => id !== taskId);
        const targetIdx = filtered.indexOf(indicator.targetSessionId);

        if (targetIdx !== -1) {
          const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
          filtered.splice(insertIdx, 0, taskId);
          taskStore.reorderTasks(filtered, projectViewId ?? task.projectViewId);
          boardStore.flashDrop(taskId);
          void captureTelemetryEvent('workspace_item_moved', {
            item_type: 'task',
            move_kind: 'reorder',
            item_count: 1,
          });
        }
      } else if (task && task.workflowStatus !== status) {
        taskStore.updateTask(
          taskId,
          { workflowStatus: status },
          projectViewId ?? undefined,
        );
        boardStore.flashDrop(taskId);
        void captureTelemetryEvent('workspace_item_moved', {
          item_type: 'task',
          move_kind: 'workflow_status',
          item_count: 1,
        });
      }
    }

    finishDrop();
  }, [chats, groupByProject, projectViewId, projects, status, tasks]);

  // Card drag-over: Ring Gradient highlight using column status color
  const dragOverStyle = isDragOver
    ? {
        '--status-color': config.color,
        background: `linear-gradient(180deg, color-mix(in srgb, ${config.color} 10%, transparent) 0%, color-mix(in srgb, ${config.color} 4%, transparent) 100%)`,
        boxShadow: [
          `inset 0 0 0 2px color-mix(in srgb, ${config.color} 30%, transparent)`,
          `0 0 0 4px color-mix(in srgb, ${config.color} 8%, transparent)`,
          `0 8px 24px color-mix(in srgb, ${config.color} 12%, transparent)`,
        ].join(', '),
        transform: 'scale(1.01)',
      } as React.CSSProperties
    : undefined;

  return (
    <div
      className={cn(
        'relative w-[268px] shrink-0 flex flex-col h-full',
        'transition-all duration-200',
        // Card drag-over: ring gradient highlight
        isDragOver && 'rounded-[14px]',
      )}
      style={dragOverStyle}
      data-testid="kanban-column"
      data-status={status}
      onDragOver={isEditable ? handleDragOver : undefined}
      onDragLeave={isEditable ? handleDragLeave : undefined}
      onDrop={isEditable ? handleDrop : undefined}
    >
      {/* Column header */}
      <div className={cn(
        'flex items-center gap-2 mx-1 px-2.5 pt-1 pb-2.5 shrink-0 border-b',
        isDragOver
          ? 'border-[color-mix(in_srgb,var(--status-color)_20%,transparent)]'
          : 'border-[color-mix(in_srgb,var(--text-muted)_15%,transparent)]',
      )}>
        {/* Status dot */}
        {status === 'todo' ? (
          <div
            className="w-2 h-2 rounded-full shrink-0 border-2 box-border"
            style={{ borderColor: config.color }}
          />
        ) : status === 'done' ? (
          <span className="text-[0.6875rem] text-(--text-muted) opacity-50 shrink-0">&#10003;</span>
        ) : (
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              background: config.color,
              ...(status === 'in_progress' ? { boxShadow: `0 0 6px color-mix(in srgb, ${config.color} 42%, transparent)` } : {}),
            }}
          />
        )}

        {/* Status label */}
        <span
          className={cn(
            'flex-1 text-[0.75rem] font-bold uppercase tracking-wider truncate',
          )}
          style={{ color: config.color }}
        >
          {config.label}
        </span>

        {/* Count pill */}
        <span
          className={cn(
            'text-[0.625rem] font-semibold tabular-nums px-[7px] py-px rounded-[10px] transition-colors duration-200',
            !isDragOver && 'bg-(--board-count-bg) text-(--board-count-text)',
          )}
          style={isDragOver
            ? { background: `color-mix(in srgb, ${config.color} 15%, transparent)`, color: config.color }
            : undefined
          }
        >
          {tasks.length + chats.length}
        </span>

        {!groupByProject && isEditable ? (
          <KanbanQuickCreateButton
            project={createProject}
            column={status}
            collection={collection}
            collections={collections}
            isOpen={quickCreateProjectId === createProject?.encodedDir}
            onToggle={onToggleQuickCreate}
            onClose={onCloseQuickCreate}
            testId="kanban-workflow-column-add-btn"
          />
        ) : null}
      </div>

      {/* Cards */}
      <div
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden',
          'px-2 pb-2.5 pt-2.5',
          'min-h-[80px]',
        )}
        data-testid="kanban-column-cards"
      >
        <div className="flex flex-col gap-2.5">
          {projectGroups.map((group, groupIndex) => (
            <Fragment key={group.project?.encodedDir ?? `single-${groupIndex}`}>
              {group.project && (
                <PortfolioProjectHeader
                  project={group.project}
                  count={group.tasks.length + group.chats.length}
                  column={status}
                  collection={collection}
                  collections={collectionsByProject[group.project.encodedDir] ?? collections}
                  isQuickCreateOpen={quickCreateProjectId === group.project.encodedDir}
                  interactionMode={interactionMode}
                  onToggleQuickCreate={onToggleQuickCreate}
                  onCloseQuickCreate={onCloseQuickCreate}
                />
              )}
              <div className="flex flex-col gap-1.5">
                {group.tasks.map((task) => (
                  <KanbanTaskCard
                    key={task.id}
                    task={task}
                    activeSessionId={activeSessionId}
                    dropIndicatorBefore={dropIndicator?.targetSessionId === task.id && dropIndicator.position === 'before'}
                    dropIndicatorAfter={dropIndicator?.targetSessionId === task.id && dropIndicator.position === 'after'}
                    dragEnabled
                    onDragStart={isEditable
                      ? undefined
                      : (e) => handlePanelOnlyTaskDragStart(task, e)}
                    onDragOverItem={isEditable ? (e) => handleTaskDragOver(task.id, e) : undefined}
                    onSessionClick={onSessionClick}
                    onSessionDoubleClick={onSessionDoubleClick}
                    onAddSession={onAddSession}
                    onContextMenu={onTaskContextMenu}
                    onRename={onTaskRename}
                    onSessionRename={onSessionRename}
                    onSessionDelete={onSessionDelete}
                    onSessionOpenInNewTab={onSessionOpenInNewTab}
                    onSessionGenerateTitle={onSessionGenerateTitle}
                    onSessionStopProcess={onSessionStopProcess}
                    isRenameRequested={renamingTaskId === task.id}
                    onRenameComplete={() => onTaskRenameComplete?.(task.id)}
                  />
                ))}
                {group.chats.map((session) => (
                  <KanbanChatCard
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    dropIndicatorBefore={dropIndicator?.targetSessionId === session.id && dropIndicator.position === 'before'}
                    dropIndicatorAfter={dropIndicator?.targetSessionId === session.id && dropIndicator.position === 'after'}
                    dragEnabled
                    onDragStart={isEditable
                      ? (e) => onChatDragStart(session.id, e)
                      : (e) => handlePanelOnlyChatDragStart(session, e)}
                    onDragEnd={isEditable ? onChatDragEnd : undefined}
                    onDragOverItem={isEditable ? (e) => onChatDragOver(session.id, status, e) : undefined}
                    onClick={(e) => onSessionClick(session, e)}
                    onDoubleClick={() => onSessionDoubleClick(session)}
                    onStatusChange={onChatStatusChange}
                    onArchive={onChatArchive}
                    onUnarchive={onChatUnarchive}
                    onRename={onSessionRename}
                    onDelete={onSessionDelete}
                    onOpenInNewTab={onSessionOpenInNewTab}
                    onGenerateTitle={onSessionGenerateTitle}
                    onMoveToCollection={(sessionId, collectionId) =>
                      useSessionStore.getState().updateSessionCollection(
                        sessionId,
                        collectionId,
                        session.projectDir,
                      )
                    }
                    onStopProcess={onSessionStopProcess}
                    collections={collectionsByProject[session.projectDir]}
                  />
                ))}
              </div>
            </Fragment>
          ))}
        </div>

        {/* Empty state */}
        {tasks.length + chats.length === 0 && isEditable ? (
          <div
            className={cn(
              'flex items-center justify-center py-6',
              'text-[0.6875rem] transition-all duration-200',
              isDragOver
                ? 'opacity-80 font-semibold'
                : 'text-(--text-muted) opacity-40',
            )}
            style={isDragOver ? { color: config.color } : undefined}
            data-testid="kanban-column-empty"
          >
            {t('task.board.emptyColumn')}
          </div>
        ) : null}
      </div>
    </div>
  );
});
