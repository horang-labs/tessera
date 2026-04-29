'use client';

import { memo, useRef, useCallback, useMemo } from 'react';
import type React from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';
import { useBoardStore } from '@/stores/board-store';
import { useTaskStore } from '@/stores/task-store';
import { TASK_ENTITY_DND_MIME } from '@/types/task';
import { WORKFLOW_STATUS_CONFIG } from '@/types/task-entity';
import type { WorkflowStatus, TaskEntity } from '@/types/task-entity';
import type { UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import { CollectionQuickCreateSheet } from '@/components/chat/collection-quick-create-sheet';
import { KanbanChatCard, KanbanTaskCard } from './kanban-card';

// ============================================================
// KanbanChatColumn
// ============================================================

interface KanbanChatColumnProps {
  chats: UnifiedSession[];
  collection: Collection | null;
  collections: Collection[];
  projectId: string;
  projectDir: string;
  activeSessionId: string | null;
  isAddMenuOpen: boolean;
  onCardDragStart: (sessionId: string, e: React.DragEvent) => void;
  onCardDragEnd: (e: React.DragEvent) => void;
  onCardDragOver: (sessionId: string, status: string, e: React.DragEvent) => void;
  onColumnDragOver: (status: string, e: React.DragEvent) => void;
  onColumnDragLeave: (status: string, e: React.DragEvent) => void;
  onColumnDrop: (status: string, e: React.DragEvent) => void;
  onCardClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onCardDoubleClick: (session: UnifiedSession) => void;
  onToggleAddMenu: () => void;
  onCloseAddMenu: () => void;
  // Context menu actions
  onCardStatusChange?: (taskId: string, status: string) => void;
  onCardArchive?: (taskId: string) => void;
  onCardUnarchive?: (taskId: string) => void;
  onCardRename?: (taskId: string, newTitle: string) => void;
  onCardDelete?: (taskId: string) => void;
  onCardOpenInNewTab?: (taskId: string) => void;
  onCardGenerateTitle?: (taskId: string) => void;
  onCardMoveToProject?: (taskId: string) => void;
  onCardMoveToCollection?: (taskId: string, collectionId: string | null) => void;
  onCardStopProcess?: (taskId: string) => void;
}

export const KanbanChatColumn = memo(function KanbanChatColumn({
  chats,
  collection,
  collections,
  projectId,
  projectDir,
  activeSessionId,
  isAddMenuOpen,
  onCardDragStart,
  onCardDragEnd,
  onCardDragOver,
  onColumnDragOver,
  onColumnDragLeave,
  onColumnDrop,
  onCardClick,
  onCardDoubleClick,
  onToggleAddMenu,
  onCloseAddMenu,
  onCardStatusChange,
  onCardArchive,
  onCardUnarchive,
  onCardRename,
  onCardDelete,
  onCardOpenInNewTab,
  onCardGenerateTitle,
  onCardMoveToProject,
  onCardMoveToCollection,
  onCardStopProcess,
}: KanbanChatColumnProps) {
  const { t } = useI18n();
  const addMenuRef = useRef<HTMLDivElement>(null);
  const isDragOver = useBoardStore((s) => s.dragOverStatus === 'chat' && s.draggingTaskId !== null);
  const dropIndicator = useBoardStore((s) => s.dropIndicator);

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
        {/* Add button with dropdown */}
        <div ref={addMenuRef} className="relative shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleAddMenu();
            }}
            className={cn(
              'w-5 h-5 flex items-center justify-center rounded-[5px]',
              'border-none bg-transparent',
              'text-(--text-muted) hover:text-(--accent-light)',
              'hover:bg-[color-mix(in_srgb,var(--accent)_15%,transparent)]',
              'transition-all cursor-pointer',
            )}
            data-testid="kanban-column-add-btn"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {isAddMenuOpen && (
            <div data-testid="kanban-column-add-menu">
              <CollectionQuickCreateSheet
                collection={collection}
                collections={collections}
                projectId={projectId}
                projectDir={projectDir}
                onClose={onCloseAddMenu}
                allowedModes={['chat']}
                allowCollectionSelection={collection === null}
                scopeId="kanban-chat"
                boundaryRef={addMenuRef}
                anchorRef={addMenuRef}
                className="left-0 right-auto top-8"
              />
            </div>
          )}
        </div>
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
        onDragOver={(e) => onColumnDragOver('chat', e)}
        onDragLeave={(e) => onColumnDragLeave('chat', e)}
        onDrop={(e) => onColumnDrop('chat', e)}
      >
        <div className="flex flex-col gap-1.5">
          {chats.map((session) => (
            <KanbanChatCard
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              dropIndicatorBefore={dropIndicator?.targetSessionId === session.id && dropIndicator.position === 'before'}
              dropIndicatorAfter={dropIndicator?.targetSessionId === session.id && dropIndicator.position === 'after'}
              onDragStart={(e) => onCardDragStart(session.id, e)}
              onDragEnd={onCardDragEnd}
              onDragOverItem={(e) => onCardDragOver(session.id, 'chat', e)}
              onClick={(e) => onCardClick(session, e)}
              onDoubleClick={() => onCardDoubleClick(session)}
              onStatusChange={onCardStatusChange}
              onArchive={onCardArchive}
              onUnarchive={onCardUnarchive}
              onRename={onCardRename}
              onDelete={onCardDelete}
              onOpenInNewTab={onCardOpenInNewTab}
              onGenerateTitle={onCardGenerateTitle}
              onMoveToProject={onCardMoveToProject}
              onMoveToCollection={onCardMoveToCollection}
              onStopProcess={onCardStopProcess}
            />
          ))}
        </div>

        {chats.length === 0 && (
          <div className="flex items-center justify-center py-6 text-[0.6875rem] text-(--text-muted) opacity-40">
            {t('task.board.emptyColumn')}
          </div>
        )}
      </div>
    </div>
  );
});

// ============================================================
// KanbanWorkflowColumn
// ============================================================

interface KanbanWorkflowColumnProps {
  status: WorkflowStatus;
  tasks: TaskEntity[];
  sessionsByTaskId: Record<string, UnifiedSession[]>;
  activeSessionId: string | null;
  onCreateTask?: () => void;
  isQuickCreateOpen?: boolean;
  quickCreateSheet?: React.ReactNode;
  quickCreateConfig?: {
    collection: Collection | null;
    collections: Collection[];
    projectDir: string;
    projectId: string;
    allowCollectionSelection: boolean;
    onClose: () => void;
  };
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick: (session: UnifiedSession) => void;
  onAddSession?: (task: TaskEntity, providerId?: string) => void;
  onTaskContextMenu?: (task: TaskEntity, anchorRect: DOMRect) => void;
  onTaskRename?: (taskId: string, newTitle: string) => void;
  onSessionRename?: (sessionId: string, newTitle: string) => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionOpenInNewTab?: (sessionId: string) => void;
  onSessionGenerateTitle?: (sessionId: string) => void;
  onSessionMoveToProject?: (sessionId: string) => void;
  onSessionStopProcess?: (sessionId: string) => void;
  renamingTaskId?: string | null;
  onTaskRenameComplete?: (taskId: string) => void;
}

export const KanbanWorkflowColumn = memo(function KanbanWorkflowColumn({
  status,
  tasks,
  sessionsByTaskId,
  activeSessionId,
  onCreateTask,
  isQuickCreateOpen,
  quickCreateSheet,
  quickCreateConfig,
  onSessionClick,
  onSessionDoubleClick,
  onAddSession,
  onTaskContextMenu,
  onTaskRename,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionMoveToProject,
  onSessionStopProcess,
  renamingTaskId,
  onTaskRenameComplete,
}: KanbanWorkflowColumnProps) {
  const { t } = useI18n();
  const addMenuRef = useRef<HTMLDivElement>(null);
  const config = WORKFLOW_STATUS_CONFIG[status];
  const tasksWithLiveSessions = useMemo(
    () => mergeTasksWithLiveSessions(tasks, Object.values(sessionsByTaskId).flat()),
    [sessionsByTaskId, tasks],
  );
  // DnD: highlight when a task card is dragged over this column
  const isDragOver = useBoardStore((s) => s.dragOverStatus === status && s.draggingTaskId !== null);
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

    const draggingTask = useTaskStore.getState().getTask(draggingTaskId);
    if (!draggingTask || draggingTask.workflowStatus !== status) {
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
  }, [status]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TASK_ENTITY_DND_MIME)) return;
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
    if (!e.dataTransfer.types.includes(TASK_ENTITY_DND_MIME)) return;

    const taskId = e.dataTransfer.getData(TASK_ENTITY_DND_MIME);
    if (taskId) {
      const task = useTaskStore.getState().getTask(taskId);
      const indicator = useBoardStore.getState().dropIndicator;

      if (task && task.workflowStatus === status && indicator) {
        const orderedIds = tasks
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((item) => item.id);
        const filtered = orderedIds.filter((id) => id !== taskId);
        const targetIdx = filtered.indexOf(indicator.targetSessionId);

        if (targetIdx !== -1) {
          const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
          filtered.splice(insertIdx, 0, taskId);
          useTaskStore.getState().reorderTasks(filtered);
          useBoardStore.getState().flashDrop(taskId);
        }
      } else if (task && task.workflowStatus !== status) {
        useTaskStore.getState().updateTask(taskId, { workflowStatus: status });
        useBoardStore.getState().flashDrop(taskId);
      }
    }

    useBoardStore.getState().setDragging(null);
    useBoardStore.getState().setDragOver(null);
    useBoardStore.getState().setDropIndicator(null);
  }, [status, tasks]);

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
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
          {tasks.length}
        </span>

        <div
          ref={addMenuRef}
          className="relative shrink-0"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={onCreateTask}
            className={cn(
              'w-5 h-5 flex items-center justify-center rounded-[5px] shrink-0',
              'border-none bg-transparent transition-all',
              'text-(--text-muted) hover:text-(--accent-light)',
              'hover:bg-[color-mix(in_srgb,var(--accent)_15%,transparent)]',
              'cursor-pointer',
            )}
            aria-label={t('task.newChat.newTask')}
            data-testid="kanban-workflow-column-add-btn"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {isQuickCreateOpen && quickCreateConfig ? (
            <CollectionQuickCreateSheet
              collection={quickCreateConfig.collection}
              collections={quickCreateConfig.collections}
              projectDir={quickCreateConfig.projectDir}
              projectId={quickCreateConfig.projectId}
              initialMode="task"
              availableModes={['task']}
              workflowStatus={status}
              allowCollectionSelection={quickCreateConfig.allowCollectionSelection}
              scopeId={`kanban-${status}`}
              anchorRef={addMenuRef}
              onClose={quickCreateConfig.onClose}
            />
          ) : (
            isQuickCreateOpen && quickCreateSheet
          )}
        </div>
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
        <div className="flex flex-col gap-1.5">
          {tasksWithLiveSessions.map((task) => (
            <KanbanTaskCard
              key={task.id}
              task={task}
              activeSessionId={activeSessionId}
              dropIndicatorBefore={dropIndicator?.targetSessionId === task.id && dropIndicator.position === 'before'}
              dropIndicatorAfter={dropIndicator?.targetSessionId === task.id && dropIndicator.position === 'after'}
              onDragOverItem={(e) => handleTaskDragOver(task.id, e)}
              onSessionClick={onSessionClick}
              onSessionDoubleClick={onSessionDoubleClick}
              onAddSession={onAddSession}
              onContextMenu={onTaskContextMenu}
              onRename={onTaskRename}
              onSessionRename={onSessionRename}
              onSessionDelete={onSessionDelete}
              onSessionOpenInNewTab={onSessionOpenInNewTab}
              onSessionGenerateTitle={onSessionGenerateTitle}
              onSessionMoveToProject={onSessionMoveToProject}
              onSessionStopProcess={onSessionStopProcess}
              isRenameRequested={renamingTaskId === task.id}
              onRenameComplete={() => onTaskRenameComplete?.(task.id)}
            />
          ))}
        </div>

        {/* Empty state */}
        {tasksWithLiveSessions.length === 0 && (
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
        )}
      </div>
    </div>
  );
});
