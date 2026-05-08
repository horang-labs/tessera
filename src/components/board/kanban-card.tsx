'use client';

import { memo, useState, useCallback, useRef } from 'react';
import type React from 'react';
import { FolderGit2, MessageSquare, Plus, Tag, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getTitleGeneratingStyle } from '@/lib/title-generating-style';
import { setKanbanTaskDragData, setPanelSessionDragData } from '@/lib/dnd/panel-session-drag';
import { useArchiveConfirm } from '@/hooks/use-archive-confirm';
import { useCollectionStore } from '@/stores/collection-store';
import { useBoardStore } from '@/stores/board-store';
import {
  selectAnyAwaitingUserPrompt,
  selectAnyTurnInFlight,
  selectIsAwaitingUserPrompt,
  selectIsTurnInFlight,
  useChatStore,
} from '@/stores/chat-store';
import { useProvidersStore } from '@/stores/providers-store';
import { useSessionStore } from '@/stores/session-store';
import { useSelectionStore } from '@/stores/selection-store';
import { useTaskStore } from '@/stores/task-store';
import { TASK_MULTI_DND_MIME } from '@/types/task';
import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession, WorkflowStatus } from '@/types/task-entity';
import { TaskContextMenu } from '@/components/chat/task-context-menu';
import { ProviderQuickMenu } from '@/components/chat/provider-quick-menu';
import { useInlineRename } from '@/hooks/use-inline-rename';
import {
  ArchiveConfirmButton,
  getWorktreeIconClass,
  InlineRenameInput,
  ItemStatusIndicator,
  OverflowMenuButton,
  StopProcessButton,
} from '@/components/chat/work-item-primitives';
import { DiffStatsBadge } from '@/components/chat/diff-stats-badge';
import { TaskPrBadge, detectPrMismatch, prMismatchTooltip } from '@/components/chat/task-pr-badge';

// --- Helpers ---

function formatRelativeTime(
  timestamp: string | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return t('time.just');
  if (minutes < 60) return t('time.minutesAgo', { minutes });
  if (hours < 24) return t('time.hoursAgo', { hours });
  if (days < 7) return t('time.daysAgo', { days });
  return date.toLocaleDateString();
}

/** Collection name label with Tag icon (matching list view) */
function CollectionLabel({ collectionId, isActive }: { collectionId?: string; isActive?: boolean }) {
  const config = collectionId
    ? useCollectionStore.getState().getCollectionConfig(collectionId)
    : null;
  if (!config) return null;

  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[0.6875rem]',
      isActive ? 'text-(--text-primary) opacity-55' : 'text-(--text-muted)',
    )}>
      <Tag className="w-2.5 h-2.5" />
      {config.label}
    </span>
  );
}

// ============================================================
// KanbanChatCard -- card for chat sessions (no task association)
// ============================================================

interface KanbanChatCardProps {
  session: UnifiedSession;
  isActive: boolean;
  dropIndicatorBefore?: boolean;
  dropIndicatorAfter?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOverItem?: (e: React.DragEvent) => void;
  onClick: (event?: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onStatusChange?: (taskId: string, status: string) => void;
  onArchive?: (taskId: string) => void;
  onUnarchive?: (taskId: string) => void;
  onRename?: (taskId: string, newTitle: string) => void;
  onDelete?: (taskId: string) => void;
  onOpenInNewTab?: (taskId: string) => void;
  onGenerateTitle?: (taskId: string) => void;
  onMoveToProject?: (taskId: string) => void;
  onMoveToCollection?: (taskId: string, collectionId: string | null) => void;
  onStopProcess?: (sessionId: string) => void;
}

export const KanbanChatCard = memo(function KanbanChatCard({
  session,
  isActive,
  dropIndicatorBefore,
  dropIndicatorAfter,
  onDragStart,
  onDragEnd,
  onDragOverItem,
  onClick,
  onDoubleClick,
  onStatusChange,
  onArchive,
  onUnarchive,
  onRename,
  onDelete,
  onOpenInNewTab,
  onGenerateTitle,
  onMoveToProject,
  onMoveToCollection,
  onStopProcess,
}: KanbanChatCardProps) {
  const { t } = useI18n();
  const collections = useCollectionStore((state) => state.collections);
  const isSelected = useSelectionStore((s) => s.selectedIds.has(session.id));
  const isProcessing = useChatStore(selectIsTurnInFlight(session.id));
  const isAwaitingUser = useChatStore(selectIsAwaitingUserPrompt(session.id));
  const isGeneratingTitle = useSessionStore((s) => s.generatingTitleIds.has(session.id));
  const isJustDropped = useBoardStore((s) => s.justDroppedId === session.id);
  const isDragging = useBoardStore((s) => s.draggingTaskId === session.id);
  const [isHovered, setIsHovered] = useState(false);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const {
    inputRef: renameInputRef,
    isRenaming,
    renameValue,
    setRenameValue,
    startRenaming,
    confirmRename,
    cancelRename,
  } = useInlineRename({
    initialValue: session.title,
    onRename: (newTitle) => onRename?.(session.id, newTitle),
  });

  const timeStr = formatRelativeTime(session.createdAt, t);
  const hasUnread = !isActive && (session.unreadCount ?? 0) > 0;
  const stripeClass = isProcessing
    ? 'task-stripe task-stripe-processing'
    : isAwaitingUser
      ? 'task-stripe task-stripe-attention'
    : hasUnread
      ? 'task-stripe task-stripe-unread'
      : session.isRunning
        ? 'task-stripe task-stripe-running'
        : null;
  const stripeLabel = isProcessing
    ? t('status.processing')
    : isAwaitingUser
      ? t('status.inputRequired')
    : hasUnread
      ? t('status.unreadNotification')
      : session.isRunning
        ? t('status.sessionRunning')
        : null;
  const titleAnimationKey = isGeneratingTitle
    ? `${session.id}:generating`
    : `${session.id}:${session.title}:${session.hasCustomTitle ? 'custom' : 'plain'}`;

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) setMenuAnchorRect(rect);
  }, []);

  const handleCloseMenu = useCallback(() => setMenuAnchorRect(null), []);

  const handleStatusChange = useCallback((status: string) => {
    onStatusChange?.(session.id, status);
  }, [session.id, onStatusChange]);

  const handleArchive = useCallback(() => onArchive?.(session.id), [session.id, onArchive]);
  const handleUnarchive = useCallback(() => onUnarchive?.(session.id), [session.id, onUnarchive]);
  const canArchiveSession = !session.taskId && Boolean(onArchive && onUnarchive);
  const handleRename = useCallback(() => {
    handleCloseMenu();
    startRenaming();
  }, [handleCloseMenu, startRenaming]);
  const handleDelete = useCallback(() => onDelete?.(session.id), [session.id, onDelete]);
  const handleOpenInNewTab = useCallback(() => onOpenInNewTab?.(session.id), [session.id, onOpenInNewTab]);

  const handleMoveToProject = useCallback(() => onMoveToProject?.(session.id), [session.id, onMoveToProject]);
  const handleStopProcess = useCallback(() => onStopProcess?.(session.id), [session.id, onStopProcess]);
  const {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  } = useArchiveConfirm(handleArchive);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = new DOMRect(e.clientX, e.clientY, 0, 0);
    setMenuAnchorRect(rect);
  }, []);

  return (
    <>
      {dropIndicatorBefore && (
        <div className="mx-2 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
      <div
        role="button"
        tabIndex={0}
        draggable={!isRenaming}
        onDragStart={!isRenaming ? onDragStart : undefined}
        onDragEnd={!isRenaming ? onDragEnd : undefined}
        onDragOver={onDragOverItem}
        onClick={(e) => {
          if (!isRenaming) onClick(e);
        }}
        onDoubleClick={() => {
          if (!isRenaming) onDoubleClick();
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        onContextMenu={isRenaming ? undefined : handleContextMenu}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          resetArchiveConfirm();
        }}
        className={cn(
          // Base layout — flatter card, consistent with list view
          'group/card relative w-full rounded-lg p-2.5 px-3',
          'text-left cursor-grab select-none',
          'transition-all duration-150',
          stripeClass,
          isDragging
            ? [
                'cursor-grabbing',
                'border-2 border-dashed',
                '[&>*]:invisible',
              ]
            : [
                'border',
                'bg-(--board-card-bg)',
                'border-(--board-card-border)',
                !(isActive && !isSelected) && [
                  'hover:bg-(--board-card-hover-bg)',
                  'hover:border-(--board-card-hover-border)',
                ],
                isActive && !isSelected && [
                  'bg-[color-mix(in_srgb,var(--accent)_8%,var(--board-card-bg))]',
                  'border-[color-mix(in_srgb,var(--accent)_26%,var(--board-card-border))]',
                  'ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]',
                ],
                isSelected && [
                  'bg-[color-mix(in_srgb,var(--accent)_6%,var(--board-card-bg))]',
                  'border-[color-mix(in_srgb,var(--accent)_24%,var(--board-card-border))]',
                  'ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,transparent)]',
                ],
                isJustDropped && 'drop-flash',
              ],
        )}
        style={isDragging ? {
          backgroundColor: 'color-mix(in srgb, var(--accent) 4%, transparent)',
          borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
          boxShadow: 'none',
        } : undefined}
        data-testid="kanban-card"
        data-card-type="chat"
        data-session-id={session.id}
        title={stripeLabel ?? undefined}
      >
        {/* Main row: icon + content */}
        <div className="flex items-start gap-2.5">
          {/* Chat icon with Discord-style status overlay */}
          <span className="shrink-0 flex items-center relative mt-[3px]">
            <MessageSquare className={cn(
              'w-3.5 h-3.5',
              isActive && !isSelected ? 'text-(--text-primary) opacity-45' : 'text-(--text-muted) opacity-35',
            )} />
            <ItemStatusIndicator
              isProcessing={isProcessing}
              isAwaitingUser={isAwaitingUser}
              hasUnread={hasUnread}
              isRunning={session.isRunning}
              placement="corner"
              surface="board"
            />
          </span>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Title — 2 lines max */}
            {isRenaming ? (
              <InlineRenameInput
                inputRef={renameInputRef}
                value={renameValue}
                onValueChange={setRenameValue}
                onConfirm={confirmRename}
                onCancel={cancelRename}
                className="w-full border-b border-(--accent) bg-transparent text-[0.8125rem] font-medium leading-[1.45] text-(--text-primary) outline-none"
                testId="kanban-card-title-input"
              />
            ) : (
              <div
                key={titleAnimationKey}
                className={cn(
                  'text-[0.8125rem] leading-[1.45] line-clamp-2',
                  isGeneratingTitle
                    ? 'title-generating font-medium'
                    : cn('font-medium', session.hasCustomTitle && 'title-fade-in'),
                  'text-(--text-primary)',
                )}
                style={isGeneratingTitle ? getTitleGeneratingStyle(session.id) : undefined}
                data-testid="kanban-card-title"
              >
                {isGeneratingTitle ? 'Generating title...' : session.title}
              </div>
            )}

            {/* Meta row: time + collection */}
            <div className="flex items-center gap-2 flex-wrap min-w-0 mt-1.5">
              {timeStr && (
                <span
                  className={cn("text-[0.625rem] shrink-0 whitespace-nowrap", isActive && !isSelected ? 'text-(--text-primary) opacity-55' : 'text-(--text-muted) opacity-60')}
                  data-testid="kanban-card-time"
                >
                  {timeStr}
                </span>
              )}

              <CollectionLabel collectionId={session.collectionId} isActive={isActive && !isSelected} />
              <DiffStatsBadge stats={session.diffStats} className="ml-auto" />
            </div>
          </div>
        </div>

        {/* Hover action buttons — aligned with the title's first line. */}
        <div
          className={cn(
            'absolute right-2 top-2.5 z-10 flex items-center gap-0.5 pl-6',
            (isHovered || menuAnchorRect) && !isRenaming ? 'opacity-100' : 'opacity-0 pointer-events-none',
            'transition-opacity duration-150',
          )}
          style={{
            background: (isHovered || menuAnchorRect) && !isRenaming
              ? `linear-gradient(to right, transparent, ${
                  isActive && !isSelected
                    ? 'color-mix(in srgb, var(--accent) 8%, var(--board-card-bg))'
                    : 'var(--board-card-hover-bg)'
                } 40%)`
              : undefined,
          }}
        >
          {session.isRunning && onStopProcess && (
            <StopProcessButton
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleStopProcess();
              }}
              className="p-0.5 rounded text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
              testId="kanban-quick-stop-button"
            />
          )}
          {canArchiveSession && (
            <ArchiveConfirmButton
              isConfirming={isConfirmingArchive}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleArchiveClick();
              }}
              className={cn(
                'p-0.5 rounded transition-all duration-150',
                isConfirmingArchive
                  ? 'text-(--success) bg-[color-mix(in_srgb,var(--success)_10%,transparent)]'
                  : isActive && !isSelected
                    ? 'text-(--text-primary) opacity-60 hover:opacity-100'
                    : 'text-(--text-muted) hover:text-(--accent-light)',
                'hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
              )}
              testId="kanban-quick-archive-button"
              confirmTitle="Click again to archive"
              idleTitle="Archive"
            />
          )}
          <OverflowMenuButton
            buttonRef={moreButtonRef}
            onClick={handleMoreClick}
            size="compact"
            className={cn(
              isActive && !isSelected
                ? 'text-(--text-primary) opacity-60 hover:opacity-100'
                : 'text-(--text-muted) hover:text-(--accent-light)',
              'hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
            )}
            ariaExpanded={menuAnchorRect !== null}
            testId="kanban-more-button"
          />
        </div>
      </div>

      {/* Context menu -- rendered in portal */}
      {menuAnchorRect && (
        <TaskContextMenu
          anchorRect={menuAnchorRect}
          currentStatus={session.taskId ? session.workflowStatus : undefined}
          isArchived={session.archived ?? false}
          collections={collections}
          currentCollectionId={session.collectionId ?? null}
          onStatusChange={session.taskId ? handleStatusChange : undefined}
          onMoveToCollection={
            onMoveToCollection ? (collectionId) => onMoveToCollection(session.id, collectionId) : undefined
          }
          onArchive={canArchiveSession ? handleArchive : undefined}
          onUnarchive={canArchiveSession ? handleUnarchive : undefined}
          onRename={handleRename}
          onDelete={handleDelete}
          onOpenInNewTab={handleOpenInNewTab}
          onGenerateTitle={onGenerateTitle ? () => onGenerateTitle(session.id) : undefined}
          isRunning={session.isRunning}
          onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
          onStopProcess={session.isRunning ? handleStopProcess : undefined}
          onClose={handleCloseMenu}
        />
      )}
      {dropIndicatorAfter && (
        <div className="mx-2 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
    </>
  );
});

// ============================================================
// KanbanTaskCard -- card for workflow tasks
// ============================================================

interface KanbanTaskCardProps {
  task: TaskEntity;
  activeSessionId: string | null;
  /** True when THIS card is the one being dragged */
  isDragging?: boolean;
  /** Drop indicator above/below */
  dropIndicatorBefore?: boolean;
  dropIndicatorAfter?: boolean;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick: (session: UnifiedSession) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOverItem?: (e: React.DragEvent) => void;
  onAddSession?: (task: TaskEntity, providerId?: string) => void;
  onContextMenu?: (task: TaskEntity, anchorRect: DOMRect) => void;
  onRename?: (taskId: string, newTitle: string) => void;
  onSessionRename?: (sessionId: string, newTitle: string) => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionOpenInNewTab?: (sessionId: string) => void;
  onSessionGenerateTitle?: (sessionId: string) => void;
  onSessionMoveToProject?: (sessionId: string) => void;
  onSessionStopProcess?: (sessionId: string) => void;
  isRenameRequested?: boolean;
  onRenameComplete?: () => void;
}

export const KanbanTaskCard = memo(function KanbanTaskCard({
  task,
  activeSessionId,
  isDragging: isDraggingProp,
  dropIndicatorBefore,
  dropIndicatorAfter,
  onSessionClick,
  onSessionDoubleClick,
  onDragStart: onDragStartProp,
  onDragEnd: onDragEndProp,
  onDragOverItem,
  onAddSession,
  onContextMenu,
  onRename,
  onSessionRename,
  onSessionDelete,
  onSessionOpenInNewTab,
  onSessionGenerateTitle,
  onSessionMoveToProject,
  onSessionStopProcess,
  isRenameRequested,
  onRenameComplete,
}: KanbanTaskCardProps) {
  const { t, language } = useI18n();
  const [isHovered, setIsHovered] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [providerMenuAnchor, setProviderMenuAnchor] = useState<DOMRect | null>(null);
  const liveProjects = useSessionStore((state) => state.projects);
  const sessionCount = task.sessions.length;
  const isMultiSession = sessionCount > 1;
  const expanded = isMultiSession;
  const isActive = task.sessions.some((s) => s.id === activeSessionId);
  const primarySessionId = task.sessions[0]?.id;
  const isGeneratingTitle = useSessionStore((state) =>
    primarySessionId ? state.generatingTitleIds.has(primarySessionId) : false,
  );
  const isJustDropped = useBoardStore((s) => s.justDroppedId === task.id);
  const isPending = task.isPending === true;
  const isSelected = useSelectionStore((s) =>
    primarySessionId ? s.selectedIds.has(primarySessionId) : false,
  );
  // Skip mismatch detection when PR sync is unsupported — we can't trust the
  // (likely empty) prStatus, so flagging "no PR" would be false-positive noise.
  const prMismatch = task.prUnsupported
    ? null
    : detectPrMismatch(task.workflowStatus, task.prStatus);
  const prMismatchReason = prMismatch ? prMismatchTooltip(prMismatch, task.prStatus?.number, t) : null;

  // Left-edge status stripe — mirrors the session status dot so the signal
  // lives on two channels (dot for precision, stripe for ambient/peripheral).
  //
  // Priority: processing (animated) > awaiting user input > unread > running > PR mismatch.

  // DnD: subscribe to draggingTaskId to dim the card being dragged
  const storeDragging = useBoardStore((s) => s.draggingTaskId === task.id);
  const isDragging = isDraggingProp ?? storeDragging;

  // Live status from session store (same pattern as list view TaskItemRow)
  const taskSessionIds = task.sessions.map((s) => s.id);
  const getLiveSession = useCallback((taskSession: TaskSession): UnifiedSession => {
    for (const project of liveProjects) {
      const session = project.sessions.find((s) => s.id === taskSession.id);
      if (session) return session;
    }
    return {
      id: taskSession.id,
      title: taskSession.title,
      provider: taskSession.provider,
      lastModified: taskSession.lastModified,
      isRunning: taskSession.isRunning,
    } as UnifiedSession;
  }, [liveProjects]);
  const hasRunningSession = useSessionStore((state) =>
    taskSessionIds.some((id) => {
      for (const p of state.projects) {
        const s = p.sessions.find((ss) => ss.id === id);
        if (s) return s.isRunning;
      }
      return false;
    })
  );
  const hasProcessingSession = useChatStore(selectAnyTurnInFlight(taskSessionIds));
  const hasAwaitingUserSession = useChatStore(selectAnyAwaitingUserPrompt(taskSessionIds));
  const hasUnreadSession = useSessionStore((state) =>
    !isActive && taskSessionIds.some((id) => {
      if (id === activeSessionId) return false;
      for (const p of state.projects) {
        const s = p.sessions.find((ss) => ss.id === id);
        if (s) return (s.unreadCount ?? 0) > 0;
      }
      return false;
    })
  );

  // Left-edge status stripe — mirrors the session dot so the signal
  // travels on two channels. Priority: processing > awaiting user input > unread > running.
  // Applied as a card-level class so the stroke follows `rounded-lg`
  // corners instead of drawing a straight line past them.
  const stripeClass = hasProcessingSession
    ? 'task-stripe task-stripe-processing'
    : hasAwaitingUserSession
      ? 'task-stripe task-stripe-attention'
    : hasUnreadSession
      ? 'task-stripe task-stripe-unread'
      : hasRunningSession
        ? 'task-stripe task-stripe-running'
        : null;
  const stripeLabel = hasProcessingSession
    ? t('status.processing')
    : hasAwaitingUserSession
      ? t('status.inputRequired')
    : hasUnreadSession
      ? t('status.unreadNotification')
      : hasRunningSession
        ? t('status.sessionRunning')
        : null;

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    const primarySession = task.sessions[0];
    if (!primarySession) return;
    onSessionClick(getLiveSession(primarySession), e);
  }, [task.sessions, getLiveSession, onSessionClick]);

  const handleCardDoubleClick = useCallback(() => {
    if (task.sessions.length === 1) {
      onSessionDoubleClick(getLiveSession(task.sessions[0]));
    }
  }, [task.sessions, getLiveSession, onSessionDoubleClick]);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) onContextMenu?.(task, rect);
  }, [task, onContextMenu]);

  const handleAddSession = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const providers = useProvidersStore.getState().providers;
    const selectable = (providers ?? []).filter((p) => p.status === 'connected');
    if (selectable.length === 1) {
      onAddSession?.(task, selectable[0].id);
      return;
    }
    const rect = addButtonRef.current?.getBoundingClientRect();
    if (rect) setProviderMenuAnchor(rect);
  }, [task, onAddSession]);

  const handleProviderMenuClose = useCallback(() => setProviderMenuAnchor(null), []);

  const handleProviderSelect = useCallback((providerId: string) => {
    onAddSession?.(task, providerId);
  }, [task, onAddSession]);

  const handleArchiveTask = useCallback(() => {
    void useTaskStore.getState().toggleTaskArchive(task.id, true);
  }, [task.id]);

  const {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  } = useArchiveConfirm(handleArchiveTask);
  const handleStopProcess = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();

    for (const session of task.sessions) {
      const liveSession = useSessionStore.getState().getSession(session.id);
      if (liveSession?.isRunning ?? session.isRunning) {
        onSessionStopProcess?.(session.id);
      }
    }
  }, [onSessionStopProcess, task.sessions]);
  const {
    inputRef: renameInputRef,
    isRenaming,
    renameValue,
    setRenameValue,
    confirmRename,
    cancelRename,
  } = useInlineRename({
    initialValue: task.title,
    isRenameRequested,
    onRename: (newTitle) => onRename?.(task.id, newTitle),
    onRenameComplete,
  });

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isRenaming) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(task, new DOMRect(e.clientX, e.clientY, 0, 0));
  }, [isRenaming, onContextMenu, task]);

  // DnD handlers
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (isRenaming) return;
    if (onDragStartProp) {
      onDragStartProp(e);
    } else {
      const selectionStore = useSelectionStore.getState();
      const isMultiDrag = Boolean(
        primarySessionId &&
        selectionStore.selectedIds.size > 1 &&
        selectionStore.selectedIds.has(primarySessionId)
      );

      if (
        primarySessionId &&
        selectionStore.selectedIds.size > 0 &&
        !selectionStore.selectedIds.has(primarySessionId)
      ) {
        selectionStore.clearSelection();
      }

      setKanbanTaskDragData(e.dataTransfer, task.id, primarySessionId);
      if (isMultiDrag) {
        e.dataTransfer.setData(TASK_MULTI_DND_MIME, JSON.stringify([...selectionStore.selectedIds]));
      }
      requestAnimationFrame(() => {
        useBoardStore.getState().setDragging(task.id);
      });
    }
  }, [isRenaming, onDragStartProp, primarySessionId, task.id]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (onDragEndProp) {
      onDragEndProp(e);
    } else {
      useBoardStore.getState().setDragging(null);
      useBoardStore.getState().setDropIndicator(null);
    }
  }, [onDragEndProp]);

  return (
    <>
      {/* Drop indicator -- before */}
      {dropIndicatorBefore && (
        <div className="mx-2 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
      <div
        role="button"
        tabIndex={isPending ? -1 : 0}
        aria-disabled={isPending || undefined}
        draggable={!isRenaming && !isPending}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={onDragOverItem}
        onClick={(e) => {
          if (isPending || isRenaming) return;
          handleCardClick(e);
        }}
        onDoubleClick={() => {
          if (isPending || isRenaming) return;
          handleCardDoubleClick();
        }}
        onKeyDown={(e) => {
          if (isPending || isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCardClick(e as unknown as React.MouseEvent);
          }
        }}
        onContextMenu={!isPending && onContextMenu ? handleContextMenu : undefined}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          resetArchiveConfirm();
        }}
        className={cn(
          // Base layout — flatter card, consistent with list view
          'group/card relative w-full rounded-lg p-2.5 px-3',
          'text-left cursor-grab select-none',
          'transition-all duration-150',
          stripeClass,
          isPending && 'pointer-events-none opacity-60',
          // Dragging state -- dashed placeholder
          isDragging
            ? [
                'cursor-grabbing',
                'border-2 border-dashed',
                '[&>*]:invisible',
              ]
            : [
                // Normal card styles
                'border',
                'bg-(--board-card-bg)',
                'border-(--board-card-border)',
                // Hover: subtle bg change (no lift)
                !(isActive && !isSelected) && [
                  'hover:bg-(--board-card-hover-bg)',
                  'hover:border-(--board-card-hover-border)',
                ],
                // Active (when one of its sessions is active)
                isActive && !isSelected && [
                  'bg-[color-mix(in_srgb,var(--accent)_8%,var(--board-card-bg))]',
                  'border-[color-mix(in_srgb,var(--accent)_26%,var(--board-card-border))]',
                  'ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]',
                ],
                isSelected && [
                  'bg-[color-mix(in_srgb,var(--accent)_6%,var(--board-card-bg))]',
                  'border-[color-mix(in_srgb,var(--accent)_24%,var(--board-card-border))]',
                  'ring-1 ring-[color-mix(in_srgb,var(--accent)_14%,transparent)]',
                ],
                // Just-dropped flash
                isJustDropped && 'drop-flash',
              ],
        )}
        style={isDragging ? {
          backgroundColor: 'color-mix(in srgb, var(--accent) 4%, transparent)',
          borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
          boxShadow: 'none',
        } : undefined}
        data-testid="kanban-card"
        data-card-type="task"
        data-task-id={task.id}
        data-session-id={primarySessionId}
        data-pr-mismatch={prMismatch ?? undefined}
        title={stripeLabel ?? undefined}
      >
        {/* Main row: icon + content */}
        <div className="flex items-start gap-2.5">
          {/* Worktree icon with Discord-style status overlay (like list view TaskItemRow) */}
          {task.worktreeBranch ? (
            <span
              title={
                task.worktreeDeletedAt
                  ? t('task.worktree.deletedWithDate', {
                      branch: task.worktreeBranch,
                      date: new Date(task.worktreeDeletedAt).toLocaleDateString(language),
                    })
                  : task.worktreeMissing
                    ? t('task.worktree.missing', { branch: task.worktreeBranch })
                  : task.worktreeBranch
              }
              className="shrink-0 flex items-center relative mt-[3px]"
            >
              <FolderGit2
                className={cn(
                  'w-3.5 h-3.5',
                  task.worktreeDeletedAt || task.worktreeMissing
                    ? 'text-(--status-error-text) opacity-70'
                    : getWorktreeIconClass(task.workflowStatus),
                )}
              />
              {(task.worktreeDeletedAt || task.worktreeMissing) && (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--status-error-text) ring-1 ring-(--board-card-bg)"
                />
              )}
              <ItemStatusIndicator
                isProcessing={hasProcessingSession}
                isAwaitingUser={hasAwaitingUserSession}
                hasUnread={hasUnreadSession}
                isRunning={hasRunningSession}
                placement="corner"
                surface="board"
              />
              {prMismatch && (
                <span
                  title={prMismatchReason ?? undefined}
                  aria-label={prMismatchReason ?? undefined}
                  className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--board-card-bg) cursor-help"
                  data-testid="task-pr-mismatch-badge"
                >
                  <TriangleAlert
                    className="h-full w-full text-(--status-warning-text)"
                    strokeWidth={2.5}
                  />
                </span>
              )}
            </span>
          ) : (
            <span className="w-3.5 shrink-0 relative flex items-center justify-center mt-[3px]">
              <ItemStatusIndicator
                isProcessing={hasProcessingSession}
                isAwaitingUser={hasAwaitingUserSession}
                hasUnread={hasUnreadSession}
                isRunning={hasRunningSession}
                placement="inline"
                surface="board"
              />
            </span>
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Title — 2 lines max */}
            {isRenaming ? (
              <InlineRenameInput
                inputRef={renameInputRef}
                value={renameValue}
                onValueChange={setRenameValue}
                onConfirm={confirmRename}
                onCancel={cancelRename}
                className="w-full border-b border-(--accent) bg-transparent text-[0.8125rem] font-medium leading-[1.45] text-(--text-primary) outline-none"
                testId="kanban-task-title-input"
              />
            ) : (
              <div
                className={cn(
                  'text-[0.8125rem] font-medium leading-[1.45] line-clamp-2',
                  (isGeneratingTitle || isPending) && 'title-generating',
                  'text-(--text-primary)',
                )}
                style={
                  isGeneratingTitle || isPending
                    ? getTitleGeneratingStyle(task.id)
                    : undefined
                }
              >
                {task.title}
              </div>
            )}

            {/* Meta row: collection + status indicators */}
            <div className="flex items-center gap-2 min-w-0 mt-1">
              <CollectionLabel collectionId={task.collectionId} isActive={isActive} />
              <span className="ml-auto inline-flex items-center gap-1.5">
                <TaskPrBadge
                  workflowStatus={task.workflowStatus}
                  prStatus={task.prStatus}
                  prUnsupported={task.prUnsupported}
                  remoteBranchExists={task.remoteBranchExists}
                  branchName={task.worktreeBranch}
                />
                <DiffStatsBadge stats={task.diffStats} />
              </span>
            </div>
          </div>
        </div>

        {/* Hover action buttons — aligned with the title's first line. Height is
            capped so the meta row (PR badges, diff stats) stays exposed. */}
        <div
          className={cn(
            'absolute right-2 top-2.5 z-10 flex items-center gap-0.5 pl-6',
            isHovered && !isRenaming ? 'opacity-100' : 'opacity-0 pointer-events-none',
            'transition-opacity duration-150',
          )}
          style={{
            background: isHovered && !isRenaming
              ? `linear-gradient(to right, transparent, ${
                  isActive
                    ? 'color-mix(in srgb, var(--accent) 8%, var(--board-card-bg))'
                    : 'var(--board-card-hover-bg)'
                } 40%)`
              : undefined,
          }}
        >
          {hasRunningSession && onSessionStopProcess && (
            <StopProcessButton
              onClick={handleStopProcess}
              className="p-0.5 rounded text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
              testId="kanban-task-quick-stop-button"
            />
          )}
          <ArchiveConfirmButton
            isConfirming={isConfirmingArchive}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleArchiveClick();
            }}
            className={cn(
              'p-0.5 rounded transition-all duration-150',
              isConfirmingArchive
                ? 'text-(--success) bg-[color-mix(in_srgb,var(--success)_10%,transparent)]'
                : isActive
                  ? 'text-(--text-primary) opacity-60 hover:opacity-100'
                  : 'text-(--text-muted) hover:text-(--accent-light) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
            )}
            testId="kanban-task-quick-archive-button"
            confirmTitle="Click again to archive task"
            idleTitle="Archive task"
          />
          {/* Add new session to this task */}
          {onAddSession && (
            <button
              ref={addButtonRef}
              onClick={handleAddSession}
              className={cn(
                'p-0.5 rounded transition-all duration-150',
                isActive
                  ? 'text-(--text-primary) opacity-60 hover:opacity-100'
                  : 'text-(--text-muted) hover:text-(--accent) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
                'active:scale-90',
              )}
              title="New session"
              data-testid="kanban-task-add-session-button"
              aria-haspopup="menu"
              aria-expanded={providerMenuAnchor !== null}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {onContextMenu && (
            <OverflowMenuButton
              buttonRef={moreButtonRef}
              onClick={handleMoreClick}
              className={cn(
                'p-0.5',
                isActive
                  ? 'text-(--text-primary) opacity-60 hover:opacity-100'
                  : 'text-(--text-muted) hover:text-(--accent-light) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
              )}
              testId="kanban-more-button"
            />
          )}
        </div>

        {/* Expanded session list with tree connectors (matching list view SubSessionRow) */}
        {!isDragging && expanded && isMultiSession && (
          <div className="relative ml-[22px] pl-3 mt-2 border-t border-(--divider) pt-1.5">
            {/* Vertical tree line */}
            <div className="absolute left-0 top-[6px] bottom-2 w-px bg-(--divider)" />
            {task.sessions.map((s) => (
              <KanbanSubSessionItem
                key={s.id}
                session={s}
                isActive={s.id === activeSessionId}
                onClick={(e) => {
                  e.stopPropagation();
                  onSessionClick(getLiveSession(s), e);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onSessionDoubleClick(getLiveSession(s));
                }}
                onRename={onSessionRename}
                onDelete={onSessionDelete}
                onOpenInNewTab={onSessionOpenInNewTab}
                onGenerateTitle={onSessionGenerateTitle}
                onStopProcess={onSessionStopProcess}
              />
            ))}

            {/* Summary context row */}
            {task.summary && (
              <div className="flex items-center gap-1.5 px-2 py-1 text-[0.6875rem] text-(--text-muted) opacity-60">
                <span>&#128203;</span>
                <span className="truncate">Summary context</span>
              </div>
            )}
          </div>
        )}
      </div>
      {providerMenuAnchor && (
        <ProviderQuickMenu
          anchorRect={providerMenuAnchor}
          currentProviderId={task.sessions[0]?.provider}
          onSelect={handleProviderSelect}
          onClose={handleProviderMenuClose}
        />
      )}
      {/* Drop indicator -- after */}
      {dropIndicatorAfter && (
        <div className="mx-2 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
    </>
  );
});

// --- Sub-session item inside expanded task card (matching list view SubSessionRow) ---

function KanbanSubSessionItem({
  session,
  isActive,
  onClick,
  onDoubleClick,
  onRename,
  onDelete,
  onOpenInNewTab,
  onGenerateTitle,
  onMoveToProject,
  onStopProcess,
}: {
  session: TaskSession;
  isActive: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onRename?: (sessionId: string, newTitle: string) => void;
  onDelete?: (sessionId: string) => void;
  onOpenInNewTab?: (sessionId: string) => void;
  onGenerateTitle?: (sessionId: string) => void;
  onMoveToProject?: (sessionId: string) => void;
  onStopProcess?: (sessionId: string) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const isProcessing = useChatStore(selectIsTurnInFlight(session.id));
  const isSelected = useSelectionStore((s) => s.selectedIds.has(session.id));
  const liveSession = useSessionStore((state) => state.getSession(session.id));
  const isGeneratingTitle = useSessionStore((state) => state.generatingTitleIds.has(session.id));
  const liveIsRunning = liveSession?.isRunning ?? session.isRunning;
  const liveUnreadCount = liveSession?.unreadCount ?? 0;
  const hasLiveUnread = !isActive && liveUnreadCount > 0;
  const isAwaitingUser = useChatStore(selectIsAwaitingUserPrompt(session.id));
  const displayTitle = liveSession?.title ?? session.title;
  const isArchived = liveSession?.archived ?? false;
  const canOpenMenu = Boolean(
    onRename ||
      onDelete ||
      onOpenInNewTab ||
      onGenerateTitle ||
      onMoveToProject ||
      (liveIsRunning && onStopProcess),
  );

  const {
    inputRef: renameInputRef,
    isRenaming,
    renameValue,
    setRenameValue,
    startRenaming,
    confirmRename,
    cancelRename,
  } = useInlineRename({
    initialValue: displayTitle,
    onRename: (newTitle) => onRename?.(session.id, newTitle),
  });

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isRenaming || !canOpenMenu) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuAnchorRect(new DOMRect(e.clientX, e.clientY, 0, 0));
  }, [canOpenMenu, isRenaming]);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect) setMenuAnchorRect(rect);
  }, []);

  const handleCloseMenu = useCallback(() => setMenuAnchorRect(null), []);

  const handleRename = useCallback(() => {
    handleCloseMenu();
    startRenaming();
  }, [handleCloseMenu, startRenaming]);

  const handleDelete = useCallback(() => onDelete?.(session.id), [onDelete, session.id]);
  const handleOpenInNewTab = useCallback(() => onOpenInNewTab?.(session.id), [onOpenInNewTab, session.id]);
  const handleGenerateTitle = useCallback(() => onGenerateTitle?.(session.id), [onGenerateTitle, session.id]);
  const handleMoveToProject = useCallback(() => onMoveToProject?.(session.id), [onMoveToProject, session.id]);
  const handleStopProcess = useCallback(() => onStopProcess?.(session.id), [onStopProcess, session.id]);
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (isRenaming) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    setPanelSessionDragData(e.dataTransfer, session.id);
    e.dataTransfer.effectAllowed = 'move';
  }, [isRenaming, session.id]);

  return (
    <>
      <div
        role="button"
        draggable={!isRenaming}
        onDragStart={handleDragStart}
        onDragEnd={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (!isRenaming) onClick(e);
        }}
        onDoubleClick={(e) => {
          if (!isRenaming) onDoubleClick(e);
        }}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={cn(
          'relative flex items-center gap-1.5 px-2 py-1 my-px rounded',
          isRenaming ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
          'text-[0.75rem] transition-colors duration-150',
          isSelected
            ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--text-primary) ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
            : isActive
              ? 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-(--accent-light) font-medium'
              : 'text-(--text-secondary) hover:bg-(--sidebar-hover)',
        )}
        data-session-id={session.id}
        data-testid={`kanban-sub-session-${session.id}`}
      >
        {/* Tree connector line */}
        <div className="absolute -left-3 top-1/2 w-[10px] h-px bg-(--divider)" />
        {isActive && <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-(--accent)" />}

        {/* Status dot overlay — at the end of the horizontal connector */}
        <ItemStatusIndicator
          isProcessing={isProcessing}
          isAwaitingUser={isAwaitingUser}
          hasUnread={hasLiveUnread}
          isRunning={liveIsRunning}
          placement="leading"
          surface="board"
        />

        {isRenaming ? (
          <InlineRenameInput
            inputRef={renameInputRef}
            value={renameValue}
            onValueChange={setRenameValue}
            onConfirm={confirmRename}
            onCancel={cancelRename}
            className="min-w-0 flex-1 border-b border-(--accent) bg-transparent text-[0.75rem] text-(--text-primary) outline-none"
            testId="kanban-sub-session-title-input"
          />
        ) : (
          <span
            className={cn('flex-1 min-w-0 truncate', isGeneratingTitle && 'title-generating')}
            style={isGeneratingTitle ? getTitleGeneratingStyle(session.id) : undefined}
          >
            {isGeneratingTitle ? 'Generating title...' : displayTitle}
          </span>
        )}

        {canOpenMenu && isHovered && !isRenaming && (
          <OverflowMenuButton
            buttonRef={moreButtonRef}
            onClick={handleMoreClick}
            size="compact"
            className="shrink-0 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)"
            ariaExpanded={menuAnchorRect !== null}
            testId="kanban-sub-session-more-button"
          />
        )}
      </div>

      {canOpenMenu && menuAnchorRect && (
        <TaskContextMenu
          anchorRect={menuAnchorRect}
          isArchived={isArchived}
          onRename={handleRename}
          onDelete={handleDelete}
          onOpenInNewTab={onOpenInNewTab ? handleOpenInNewTab : undefined}
          onGenerateTitle={onGenerateTitle ? handleGenerateTitle : undefined}
          isRunning={liveIsRunning}
          onMoveToProject={onMoveToProject ? handleMoveToProject : undefined}
          onStopProcess={liveIsRunning && onStopProcess ? handleStopProcess : undefined}
          onClose={handleCloseMenu}
        />
      )}
    </>
  );
}
