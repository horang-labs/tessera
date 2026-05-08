'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  Archive,
  Check,
  CircleStop,
  ExternalLink,
  FolderGit2,
  FolderInput,
  MessageSquare,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useArchiveConfirm } from '@/hooks/use-archive-confirm';
import { useInlineRename } from '@/hooks/use-inline-rename';
import { setPanelSessionDragData } from '@/lib/dnd/panel-session-drag';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBoardStore } from '@/stores/board-store';
import {
  selectAnyAwaitingUserPrompt,
  selectAnyTurnInFlight,
  selectIsAwaitingUserPrompt,
  selectIsTurnInFlight,
  useChatStore,
} from '@/stores/chat-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useProvidersStore } from '@/stores/providers-store';
import { useSelectionStore } from '@/stores/selection-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { COLLECTION_ITEM_DND_MIME, SIDEBAR_STATUS_GROUP_CONFIG, SIDEBAR_STATUS_GROUP_ORDER } from '@/types/task';
import type { TaskEntity, TaskSession } from '@/types/task-entity';
import type { UnifiedSession } from '@/types/chat';
import type { Collection } from '@/types/collection';
import {
  ArchiveConfirmButton,
  getWorktreeIconClass,
  InlineRenameInput,
  ItemStatusIndicator,
  OverflowMenuButton,
  StopProcessButton,
} from './work-item-primitives';
import { CollectionMoveSubmenu } from './collection-move-submenu';
import { DiffStatsBadge } from './diff-stats-badge';
import { ProviderQuickMenu } from './provider-quick-menu';
import { detectPrMismatch, prMismatchTooltip } from './task-pr-badge';
import { getTitleGeneratingStyle } from '@/lib/title-generating-style';

type CollectionItemType = 'chat' | 'task';
type ItemContextMenuHandler = (
  e: React.MouseEvent,
  type: CollectionItemType,
  id: string,
  collectionId: string | null,
  isSubSession?: boolean,
) => void;

const TASK_TITLE_ACTION_MASK =
  'linear-gradient(to right, #000 0%, #000 calc(100% - 4.75rem), rgba(0,0,0,0.35) calc(100% - 3.25rem), transparent calc(100% - 2.75rem), transparent 100%)';
const TASK_TITLE_ACTION_MASK_WITH_STOP =
  'linear-gradient(to right, #000 0%, #000 calc(100% - 5.75rem), rgba(0,0,0,0.35) calc(100% - 4.25rem), transparent calc(100% - 3rem), transparent 100%)';

function getSidebarActionSurface({
  isActive,
  isSelected,
}: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  if (isSelected) {
    return 'color-mix(in srgb, var(--accent) 8%, var(--board-bg))';
  }

  if (isActive) {
    return 'color-mix(in srgb, var(--accent) 10%, var(--board-bg))';
  }

  return 'var(--sidebar-hover)';
}

function getSidebarHoverActionFadeStyle(surface: string): React.CSSProperties {
  return {
    background: `linear-gradient(to right, transparent 0%, color-mix(in srgb, var(--board-bg) 58%, ${surface}) 18%, color-mix(in srgb, var(--board-bg) 24%, ${surface}) 42%, ${surface} 70%, ${surface} 100%)`,
  };
}

export interface ContextMenuState {
  x: number;
  y: number;
  type: CollectionItemType;
  targetId: string;
  currentCollectionId: string | null;
  isRunning?: boolean;
  isSubSession?: boolean;
  currentStatus?: string;
}

export function CollectionHeaderMenu({
  collectionId,
  onEdit,
}: {
  collectionId: string;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !btnRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handleMouseDown, true);
    return () => document.removeEventListener('mousedown', handleMouseDown, true);
  }, [open]);

  const handleToggle = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!open && btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        const menuHeight = 72;
        const menuWidth = 128;
        const vh = window.innerHeight;
        const vw = window.innerWidth;

        let top = rect.bottom + 4;
        let left = rect.right - menuWidth;

        if (top + menuHeight > vh - 8) {
          top = rect.top - menuHeight - 4;
        }
        if (left < 8) left = 8;
        if (left + menuWidth > vw - 8) left = vw - menuWidth - 8;

        setMenuPos({ top, left });
      }
      setOpen((prev) => !prev);
    },
    [open],
  );

  const handleEdit = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      setOpen(false);
      onEdit();
    },
    [onEdit],
  );

  const handleDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      setOpen(false);
      useCollectionStore.getState().deleteCollection(collectionId);
    },
    [collectionId],
  );

  return (
    <div className="shrink-0 leading-none">
      <OverflowMenuButton
        buttonRef={btnRef}
        onClick={handleToggle}
        size="compact"
        className={cn(
          'flex items-center justify-center text-(--text-muted) hover:bg-(--sidebar-hover)',
          open && 'bg-(--sidebar-hover)',
        )}
        ariaExpanded={open}
      />
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-32 rounded-lg border border-(--divider) bg-(--sidebar-bg) p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button
            onClick={handleEdit}
            className="flex w-full items-center gap-2 px-3 h-8 text-[0.75rem] text-left rounded-md text-(--sidebar-text-active) transition-colors hover:bg-(--sidebar-hover) cursor-default"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Edit</span>
          </button>
          <button
            onClick={handleDelete}
            className="flex w-full items-center gap-2 px-3 h-8 text-[0.75rem] text-left rounded-md text-(--error) transition-colors hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] cursor-default"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>Delete</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

export function CollectionContextMenu({
  menu,
  collections,
  onClose,
  onRename,
  onDelete,
  onArchive,
  onOpenInNewTab,
  onGenerateTitle,
  onMoveToProject,
  onStopProcess,
  onStatusChange,
}: {
  menu: ContextMenuState;
  collections?: Collection[];
  onClose: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onOpenInNewTab?: () => void;
  onGenerateTitle?: () => void;
  onMoveToProject?: () => void;
  onStopProcess?: () => void;
  onStatusChange?: (status: string) => void;
}) {
  const { t } = useI18n();
  const fallbackCollections = useCollectionStore((state) => state.collections);
  const menuCollections = collections ?? fallbackCollections;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: menu.y, left: menu.x });

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  useEffect(() => {
    const element = menuRef.current;
    if (!element) return;

    const frame = requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let top = menu.y;
      let left = menu.x;

      if (top + rect.height > viewportHeight - 8) {
        top = viewportHeight - rect.height - 8;
      }
      if (left + rect.width > viewportWidth - 8) {
        left = viewportWidth - rect.width - 8;
      }
      if (top < 8) top = 8;
      if (left < 8) left = 8;

      if (top !== menu.y || left !== menu.x) {
        setPosition({ top, left });
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [menu.x, menu.y]);

  const handleMoveToCollection = useCallback(
    async (collectionId: string | null) => {
      onClose();
      if (menu.type === 'chat') {
        await fetchWithClientId(`/api/sessions/${menu.targetId}/collection`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collectionId }),
        });
        await useSessionStore.getState().loadProjects();
        return;
      }

      await useTaskStore.getState().updateTask(menu.targetId, { collectionId });
    },
    [menu, onClose],
  );

  const menuItemClass = cn(
    'flex h-8 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-[0.75rem]',
    'text-(--sidebar-text-active) transition-colors',
    'hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
  );

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: position.left, top: position.top, zIndex: 9999 }}
      className="animate-in fade-in-0 zoom-in-95 duration-100"
    >
      <div className="min-w-[180px] rounded-lg border border-(--divider) bg-(--sidebar-bg) py-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]">
        {menu.isRunning && onStopProcess && (
          <>
            <button
              className={cn(menuItemClass, 'text-(--error)')}
              onClick={() => { onStopProcess(); onClose(); }}
              data-testid="ctx-stop-process"
            >
              <CircleStop className="h-3.5 w-3.5 shrink-0" />
              <span>Stop Process</span>
            </button>
            <div className="mx-2 my-1 h-px bg-(--divider) opacity-40" />
          </>
        )}

        {!menu.isSubSession && (
          <>
            <CollectionMoveSubmenu
              collections={menuCollections}
              currentCollectionId={menu.currentCollectionId}
              onMoveToCollection={(collectionId) => {
                void handleMoveToCollection(collectionId);
              }}
              triggerClassName={menuItemClass}
              itemClassName={menuItemClass}
            />
            <div className="mx-2 my-1 h-px bg-(--divider) opacity-40" />
          </>
        )}

        {onStatusChange && (
          <>
            <div className="px-3 pb-1 pt-0.5">
              <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-(--text-muted) opacity-60">
                {t('task.contextMenu.setStatus' as Parameters<typeof t>[0])}
              </span>
            </div>
            {SIDEBAR_STATUS_GROUP_ORDER.filter((s) => s !== 'chat').map((status) => {
              const config = SIDEBAR_STATUS_GROUP_CONFIG[status];
              const isCurrent = status === menu.currentStatus;
              return (
                <button
                  key={status}
                  className={cn(menuItemClass, isCurrent && 'opacity-50 cursor-default')}
                  onClick={isCurrent ? undefined : () => { onStatusChange(status); onClose(); }}
                  disabled={isCurrent}
                  data-testid={`ctx-status-${status}`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: config.color }} />
                  <span className="flex-1">{t(config.label as Parameters<typeof t>[0])}</span>
                  {isCurrent && <Check className="h-3 w-3 shrink-0 opacity-60" />}
                </button>
              );
            })}
            <div className="mx-2 my-1 h-px bg-(--divider) opacity-40" />
          </>
        )}

        {onGenerateTitle && (
          <button className={menuItemClass} onClick={() => { onGenerateTitle(); onClose(); }}>
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>{t('task.contextMenu.generateTitle' as Parameters<typeof t>[0])}</span>
          </button>
        )}

        {onRename && (
          <button className={menuItemClass} onClick={() => { onRename(); onClose(); }}>
            <Pencil className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Rename</span>
          </button>
        )}

        {onArchive && (
          <button className={menuItemClass} onClick={() => { onArchive(); onClose(); }}>
            <Archive className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Archive</span>
          </button>
        )}

        {onOpenInNewTab && (
          <button className={menuItemClass} onClick={() => { onOpenInNewTab(); onClose(); }}>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Open in New Tab</span>
          </button>
        )}

        {onMoveToProject && (
          <button
            className={cn(menuItemClass, menu.isRunning && 'pointer-events-none opacity-40')}
            onClick={() => {
              if (!menu.isRunning) {
                onMoveToProject();
                onClose();
              }
            }}
          >
            <FolderInput className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Move to Project</span>
          </button>
        )}

        {onDelete && (
          <>
            <div className="mx-2 my-1 h-px bg-(--divider) opacity-40" />
            <button
              className={cn(
                'flex h-8 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-[0.75rem]',
                'text-(--error) transition-colors hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
              )}
              onClick={() => { onDelete(); onClose(); }}
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              <span>Delete</span>
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function SubSessionRow({
  sess,
  activeSessionId,
  collectionId,
  onSessionClick,
  onSessionDoubleClick,
  onContextMenu,
  onStopProcess,
  onRename,
  isRenameRequested,
  onRenameComplete,
}: {
  sess: TaskSession;
  activeSessionId: string | null;
  collectionId: string | null;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick?: (session: UnifiedSession) => void;
  onContextMenu?: ItemContextMenuHandler;
  onStopProcess?: (sessionId: string) => void;
  onRename?: (sessionId: string, newTitle: string) => void;
  isRenameRequested?: boolean;
  onRenameComplete?: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const isActive = sess.id === activeSessionId;
  const isSelected = useSelectionStore((state) => state.selectedIds.has(sess.id));
  const isProcessing = useChatStore(selectIsTurnInFlight(sess.id));
  const isAwaitingUser = useChatStore(selectIsAwaitingUserPrompt(sess.id));
  const liveIsRunning = useSessionStore((state) => {
    for (const project of state.projects) {
      const session = project.sessions.find((item) => item.id === sess.id);
      if (session) return session.isRunning;
    }
    return sess.isRunning;
  });
  const hasUnread = useSessionStore((state) => {
    if (isActive) return false;
    for (const project of state.projects) {
      const session = project.sessions.find((item) => item.id === sess.id);
      if (session) return (session.unreadCount ?? 0) > 0;
    }
    return false;
  });
  const asUnifiedSession = useCallback(
    () =>
      ({
        id: sess.id,
        title: sess.title,
        lastModified: sess.lastModified,
        isRunning: liveIsRunning,
      }) as UnifiedSession,
    [liveIsRunning, sess],
  );
  const handleStopProcess = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    onStopProcess?.(sess.id);
  }, [onStopProcess, sess.id]);
  const {
    inputRef: renameInputRef,
    isRenaming,
    renameValue,
    setRenameValue,
    confirmRename,
    cancelRename,
  } = useInlineRename({
    initialValue: sess.title,
    isRenameRequested,
    onRename: (newTitle) => onRename?.(sess.id, newTitle),
    onRenameComplete,
  });
  const handleDragStart = useCallback((event: React.DragEvent) => {
    if (isRenaming) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    setPanelSessionDragData(event.dataTransfer, sess.id);
    event.dataTransfer.effectAllowed = 'move';
  }, [isRenaming, sess.id]);

  return (
    <div
      className={cn(
        'group/sub relative my-px flex items-center gap-1.5 rounded px-2 py-1 text-[0.75rem] transition-colors duration-150',
        isRenaming ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        isSelected
          ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--sidebar-text-active) ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
          : isActive
            ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-(--sidebar-text-active) ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
            : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
      )}
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onDragEnd={(event) => event.stopPropagation()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(event) => {
        if (isRenaming) return;
        event.stopPropagation();
        onSessionClick(asUnifiedSession(), event);
      }}
      onDoubleClick={(event) => {
        if (isRenaming) return;
        event.stopPropagation();
        onSessionDoubleClick?.(asUnifiedSession());
      }}
      onContextMenu={(event) => {
        if (isRenaming) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event, 'chat', sess.id, collectionId, true);
      }}
      data-session-id={sess.id}
      data-testid={`collection-subsession-${sess.id}`}
    >
      <div className="absolute -left-3 top-1/2 h-px w-[10px] bg-(--divider)" />
      {isActive && (
        <div className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-(--accent)" />
      )}
      <ItemStatusIndicator
        isProcessing={isProcessing}
        isAwaitingUser={isAwaitingUser}
        hasUnread={hasUnread}
        isRunning={liveIsRunning}
        placement="leading"
        surface="sidebar"
      />

      {isRenaming ? (
        <InlineRenameInput
          inputRef={renameInputRef}
          value={renameValue}
          onValueChange={setRenameValue}
          onConfirm={confirmRename}
          onCancel={cancelRename}
          className="min-w-0 flex-1 border-b border-(--accent) bg-transparent text-[0.75rem] text-(--sidebar-text-active) outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate pr-8">{sess.title}</span>
      )}

      {isHovered && !isRenaming && (
        <div className="flex shrink-0 items-center gap-0.5">
          {liveIsRunning && onStopProcess && (
            <StopProcessButton
              onClick={handleStopProcess}
              className="rounded p-0.5 text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
              testId={`collection-subsession-quick-stop-${sess.id}`}
            />
          )}
          <OverflowMenuButton
            buttonRef={moreRef}
            onClick={(event) => {
              event.stopPropagation();
              onContextMenu?.(event, 'chat', sess.id, collectionId, true);
            }}
            size="compact"
            className="shrink-0 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)"
          />
        </div>
      )}
    </div>
  );
}

export function TaskItemRow({
  task,
  activeSessionId,
  onSessionClick,
  onSessionDoubleClick,
  onContextMenu,
  isDragging,
  isJustDropped,
  dropIndicatorBefore,
  dropIndicatorAfter,
  onDragStart,
  onDragEnd,
  onDragOverItem,
  onRename,
  onSessionRename,
  renamingSessionId,
  isRenameRequested,
  onRenameComplete,
  onAddSession,
  onStopProcess,
  disableDnd,
  allowPanelSessionDnd,
}: {
  task: TaskEntity;
  activeSessionId: string | null;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick?: (session: UnifiedSession) => void;
  onContextMenu?: ItemContextMenuHandler;
  isDragging: boolean;
  isJustDropped: boolean;
  dropIndicatorBefore?: boolean;
  dropIndicatorAfter?: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOverItem: (e: React.DragEvent) => void;
  onRename?: (taskId: string, newTitle: string) => void;
  onSessionRename?: (sessionId: string, newTitle: string) => void;
  renamingSessionId?: string | null;
  isRenameRequested?: boolean;
  onRenameComplete?: () => void;
  onAddSession: (providerId?: string) => void;
  onStopProcess?: (sessionId: string) => void;
  disableDnd?: boolean;
  allowPanelSessionDnd?: boolean;
}) {
  const { t } = useI18n();
  const [isHovered, setIsHovered] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [providerMenuAnchor, setProviderMenuAnchor] = useState<DOMRect | null>(null);
  const isMultiSession = task.sessions.length > 1;
  const isTaskActive = !isMultiSession && task.sessions.length === 1 && task.sessions[0].id === activeSessionId;
  const isPending = task.isPending === true;
  const primarySessionId = task.sessions[0]?.id;
  const isGeneratingTitle = useSessionStore((state) =>
    primarySessionId ? state.generatingTitleIds.has(primarySessionId) : false,
  );
  const isSelected = useSelectionStore((state) =>
    primarySessionId ? state.selectedIds.has(primarySessionId) : false,
  );
  const hoverActionFadeStyle = getSidebarHoverActionFadeStyle(
    getSidebarActionSurface({ isActive: isTaskActive, isSelected }),
  );
  const taskSessionIds = task.sessions.map((session) => session.id);
  const hasRunningSession = useSessionStore((state) =>
    taskSessionIds.some((id) => {
      for (const project of state.projects) {
        const session = project.sessions.find((item) => item.id === id);
        if (session) return session.isRunning;
      }
      return false;
    }),
  );
  const hasProcessingSession = useChatStore(selectAnyTurnInFlight(taskSessionIds));
  const hasAwaitingUserSession = useChatStore(selectAnyAwaitingUserPrompt(taskSessionIds));
  const hasUnreadSession = useSessionStore((state) =>
    !isTaskActive &&
    taskSessionIds.some((id) => {
      if (id === activeSessionId) return false;
      for (const project of state.projects) {
        const session = project.sessions.find((item) => item.id === id);
        if (session) return (session.unreadCount ?? 0) > 0;
      }
      return false;
    }),
  );
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
  const canCollectionDnd = !disableDnd && !isRenaming && !isPending;
  const canPanelSessionDnd = Boolean(allowPanelSessionDnd && primarySessionId && !isRenaming && !isPending);
  const canDrag = canCollectionDnd || canPanelSessionDnd;
  const titleFadeStyle: React.CSSProperties | undefined = isHovered && !isRenaming
    ? {
        WebkitMaskImage: hasRunningSession ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
        maskImage: hasRunningSession ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
      }
    : undefined;

  const handleArchiveTask = useCallback(() => {
    void useTaskStore.getState().toggleTaskArchive(task.id, true);
  }, [task.id]);

  const {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  } = useArchiveConfirm(handleArchiveTask);

  const handleStopProcess = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();

    for (const session of task.sessions) {
      const liveSession = useSessionStore.getState().getSession(session.id);
      if (liveSession?.isRunning ?? session.isRunning) {
        onStopProcess?.(session.id);
      }
    }
  }, [onStopProcess, task.sessions]);

  const handleDragStart = useCallback((event: React.DragEvent) => {
    if (disableDnd) {
      event.stopPropagation();
      setPanelSessionDragData(event.dataTransfer, primarySessionId);
      event.dataTransfer.effectAllowed = 'move';
      return;
    }

    onDragStart(event);
  }, [disableDnd, onDragStart, primarySessionId]);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (isRenaming) return;
      const session = task.sessions[0];
      if (!session) return;
      onSessionClick(
        {
          id: session.id,
          title: session.title,
          lastModified: session.lastModified,
          isRunning: session.isRunning,
        } as UnifiedSession,
        event,
      );
    },
    [isRenaming, onSessionClick, task.sessions],
  );

  const handleDoubleClick = useCallback(() => {
    if (isRenaming) return;
    const session = task.sessions[0];
    if (!session) return;
    onSessionDoubleClick?.(
      {
        id: session.id,
        title: session.title,
        lastModified: session.lastModified,
        isRunning: session.isRunning,
      } as UnifiedSession,
    );
  }, [isRenaming, onSessionDoubleClick, task.sessions]);

  return (
    <div className="task-item-container" data-item-id={task.id}>
      {dropIndicatorBefore && (
        <div className="mx-3 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}

      <div
        draggable={canDrag}
        aria-disabled={isPending || undefined}
        onDragStart={canDrag ? handleDragStart : undefined}
        onDragEnd={canDrag ? onDragEnd : undefined}
        onDragOver={!disableDnd && !isPending ? onDragOverItem : undefined}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          resetArchiveConfirm();
        }}
        className={cn(
          'group/task relative mx-1 flex select-none items-center gap-2 rounded-lg px-3 py-1.5 transition-all duration-150',
          canDrag && 'cursor-grab',
          isSelected
            ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--sidebar-text-active) ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
            : isTaskActive
              ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-(--sidebar-text-active) ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
              : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
          isDragging && 'cursor-grabbing opacity-35 scale-[0.97]',
          isJustDropped && 'drop-flash',
          isRenaming && 'cursor-default',
          isPending && 'pointer-events-none opacity-60',
        )}
        onClick={isPending ? undefined : handleClick}
        onDoubleClick={isPending ? undefined : handleDoubleClick}
        onContextMenu={(event) => {
          if (isPending || isRenaming || !onContextMenu) return;
          event.preventDefault();
          onContextMenu(event, 'task', task.id, task.collectionId ?? null);
        }}
        data-session-id={task.sessions[0]?.id}
        data-testid={`collection-task-${task.id}`}
      >
        {task.worktreeBranch ? (
          <span
            title={task.worktreeMissing ? t('task.worktree.missing', { branch: task.worktreeBranch }) : task.worktreeBranch}
            className="relative flex shrink-0 items-center"
          >
            <FolderGit2
              className={cn(
                'h-3.5 w-3.5',
                task.worktreeMissing
                  ? 'text-(--status-error-text) opacity-70'
                  : getWorktreeIconClass(task.workflowStatus),
              )}
            />
            <ItemStatusIndicator
              isProcessing={hasProcessingSession}
              isAwaitingUser={hasAwaitingUserSession}
              hasUnread={hasUnreadSession}
              isRunning={hasRunningSession}
              placement="corner"
              surface="sidebar"
            />
            {(() => {
              // Skip mismatch badge when PR sync is unsupported — we have no
              // reliable prStatus to compare against the column.
              const mismatch = task.prUnsupported
                ? null
                : detectPrMismatch(task.workflowStatus, task.prStatus);
              if (!mismatch) return null;
              const reason = prMismatchTooltip(mismatch, task.prStatus?.number, t);
              return (
                <span
                  title={reason}
                  aria-label={reason}
                  className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--sidebar-bg) cursor-help"
                  data-testid="task-pr-mismatch-badge"
                >
                  <TriangleAlert
                    className="h-full w-full text-(--status-warning-text)"
                    strokeWidth={2.5}
                  />
                </span>
              );
            })()}
            {task.worktreeMissing && (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--status-error-text) ring-1 ring-(--sidebar-bg)"
              />
            )}
          </span>
        ) : (
          <span className="relative flex w-3.5 shrink-0 items-center justify-center">
            <ItemStatusIndicator
              isProcessing={hasProcessingSession}
              isAwaitingUser={hasAwaitingUserSession}
              hasUnread={hasUnreadSession}
              isRunning={hasRunningSession}
              placement="inline"
              surface="sidebar"
            />
          </span>
        )}

        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <InlineRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onValueChange={setRenameValue}
              onConfirm={confirmRename}
              onCancel={cancelRename}
              className="w-full border-b border-(--accent) bg-transparent text-[0.8125rem] font-medium text-(--sidebar-text-active) outline-none caret-(--accent)"
            />
          ) : (
            <span
              className={cn(
                'block truncate text-[0.8125rem] font-medium leading-snug text-(--sidebar-text-active)',
                (isGeneratingTitle || isPending) && 'title-generating'
              )}
              style={
                isGeneratingTitle || isPending
                  ? { ...titleFadeStyle, ...getTitleGeneratingStyle(task.id) }
                  : titleFadeStyle
              }
            >
              {task.title}
            </span>
          )}
        </div>

        {!isRenaming && (
          <DiffStatsBadge
            stats={task.diffStats}
            className={cn(
              'mr-1 transition-opacity duration-150',
              isHovered ? 'opacity-0' : 'opacity-100',
            )}
          />
        )}

        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 flex items-start justify-end rounded-r-lg pr-1.5 pt-1.5 transition-opacity duration-150',
            hasRunningSession ? 'w-28' : 'w-24',
            isHovered && !isRenaming ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-full rounded-r-lg"
            style={hoverActionFadeStyle}
          />
          <div className="relative flex pointer-events-auto items-center gap-0.5">
            {hasRunningSession && onStopProcess && (
              <StopProcessButton
                onClick={handleStopProcess}
                className="rounded p-1 text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
                testId={`collection-task-quick-stop-${task.id}`}
              />
            )}
            <ArchiveConfirmButton
              isConfirming={isConfirmingArchive}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                handleArchiveClick();
              }}
              className={cn(
                'rounded p-1 transition-all duration-150',
                isConfirmingArchive
                  ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-(--success)'
                  : 'text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:text-(--accent)',
              )}
              testId={`collection-task-quick-archive-${task.id}`}
              confirmTitle="Click again to archive task"
              idleTitle="Archive task"
            />
            <button
              ref={addButtonRef}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                const providers = useProvidersStore.getState().providers;
                const selectable = (providers ?? []).filter((p) => p.status === 'connected');
                if (selectable.length === 1) {
                  onAddSession(selectable[0].id);
                  return;
                }
                const rect = addButtonRef.current?.getBoundingClientRect();
                if (rect) setProviderMenuAnchor(rect);
              }}
              className="rounded p-1 text-(--text-muted) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:text-(--accent) active:scale-90"
              title="New session"
              data-testid={`collection-task-add-session-${task.id}`}
              aria-haspopup="menu"
              aria-expanded={providerMenuAnchor !== null}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <OverflowMenuButton
              buttonRef={moreButtonRef}
              onClick={(event) => {
                event.stopPropagation();
                if (onContextMenu && moreButtonRef.current?.getBoundingClientRect()) {
                  onContextMenu(event as unknown as React.MouseEvent, 'task', task.id, task.collectionId ?? null);
                }
              }}
              className="text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)"
            />
          </div>
        </div>
      </div>

      {isMultiSession && (
        <div
          className="relative ml-[30px] pl-3"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(COLLECTION_ITEM_DND_MIME)) return;

            const draggingItem = useBoardStore.getState().draggingCollectionItem;
            const targetCollectionId = task.collectionId ?? '__uncategorized';
            const sourceCollectionId = draggingItem?.collectionId ?? '__uncategorized';

            if (draggingItem && draggingItem.type !== 'task' && sourceCollectionId === targetCollectionId) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'none';
            }
          }}
        >
          <div className="absolute bottom-2 left-0 top-0 w-px bg-(--divider)" />
          {task.sessions.map((session) => (
            <SubSessionRow
              key={session.id}
              sess={session}
              activeSessionId={activeSessionId}
              collectionId={task.collectionId ?? null}
              onSessionClick={onSessionClick}
              onSessionDoubleClick={onSessionDoubleClick}
              onContextMenu={onContextMenu}
              onStopProcess={onStopProcess}
              onRename={onSessionRename}
              isRenameRequested={renamingSessionId === session.id}
              onRenameComplete={onRenameComplete}
            />
          ))}
        </div>
      )}

      {dropIndicatorAfter && (
        <div className="mx-3 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
      {providerMenuAnchor && (
        <ProviderQuickMenu
          anchorRect={providerMenuAnchor}
          currentProviderId={task.sessions[0]?.provider}
          onSelect={(providerId) => onAddSession(providerId)}
          onClose={() => setProviderMenuAnchor(null)}
        />
      )}
    </div>
  );
}

export function ChatItemRow({
  session,
  activeSessionId,
  onSessionClick,
  onSessionDoubleClick,
  onContextMenu,
  isDragging,
  isJustDropped,
  dropIndicatorBefore,
  dropIndicatorAfter,
  onDragStart,
  onDragEnd,
  onDragOverItem,
  onRename,
  isRenameRequested,
  onRenameComplete,
  onArchive,
  onStopProcess,
  disableDnd,
  allowPanelSessionDnd,
}: {
  session: UnifiedSession;
  activeSessionId: string | null;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick?: (session: UnifiedSession) => void;
  onContextMenu?: (e: React.MouseEvent, type: 'chat', id: string, collectionId: string | null) => void;
  isDragging: boolean;
  isJustDropped: boolean;
  dropIndicatorBefore?: boolean;
  dropIndicatorAfter?: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOverItem: (e: React.DragEvent) => void;
  onRename?: (sessionId: string, newTitle: string) => void;
  isRenameRequested?: boolean;
  onRenameComplete?: () => void;
  onArchive?: (sessionId: string) => void;
  onStopProcess?: (sessionId: string) => void;
  disableDnd?: boolean;
  allowPanelSessionDnd?: boolean;
}) {
  const isActive = session.id === activeSessionId;
  const isSelected = useSelectionStore((state) => state.selectedIds.has(session.id));
  const [isHovered, setIsHovered] = useState(false);
  const isProcessing = useChatStore(selectIsTurnInFlight(session.id));
  const isAwaitingUser = useChatStore(selectIsAwaitingUserPrompt(session.id));
  const liveIsRunning = useSessionStore((state) => state.getSession(session.id)?.isRunning ?? session.isRunning);
  const isGeneratingTitle = useSessionStore((state) => state.generatingTitleIds.has(session.id));
  const hasUnread = !isActive && (session.unreadCount ?? 0) > 0;
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  } = useArchiveConfirm(() => onArchive?.(session.id));
  const {
    inputRef: renameInputRef,
    isRenaming,
    renameValue,
    setRenameValue,
    confirmRename,
    cancelRename,
  } = useInlineRename({
    initialValue: session.title,
    isRenameRequested,
    onRename: (newTitle) => onRename?.(session.id, newTitle),
    onRenameComplete,
  });
  const hoverActionFadeStyle = getSidebarHoverActionFadeStyle(
    getSidebarActionSurface({ isActive, isSelected }),
  );
  const canDrag = (!disableDnd || allowPanelSessionDnd) && !isRenaming;
  const titleFadeStyle: React.CSSProperties | undefined = isHovered && !isRenaming
    ? {
        WebkitMaskImage: liveIsRunning ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
        maskImage: liveIsRunning ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
      }
    : undefined;
  const handleStopProcess = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    onStopProcess?.(session.id);
  }, [onStopProcess, session.id]);
  const handleDragStart = useCallback((event: React.DragEvent) => {
    if (disableDnd) {
      event.stopPropagation();
      setPanelSessionDragData(event.dataTransfer, session.id);
      event.dataTransfer.effectAllowed = 'move';
      return;
    }

    onDragStart(event);
  }, [disableDnd, onDragStart, session.id]);

  return (
    <>
      {dropIndicatorBefore && (
        <div className="mx-3 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
      <div
        draggable={canDrag}
        onDragStart={canDrag ? handleDragStart : undefined}
        onDragEnd={canDrag ? onDragEnd : undefined}
        onDragOver={!disableDnd ? onDragOverItem : undefined}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          resetArchiveConfirm();
        }}
        className={cn(
          'group/chat relative mx-1 flex select-none items-center gap-2 rounded-lg px-3 py-1.5 transition-all duration-150',
          canDrag && 'cursor-grab',
          isSelected
            ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--sidebar-text-active) ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
            : isActive
              ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-(--sidebar-text-active) ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
              : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
          isDragging && 'cursor-grabbing opacity-35 scale-[0.97]',
          isJustDropped && 'drop-flash',
        )}
        onClick={(event) => {
          if (!isRenaming) {
            onSessionClick(session, event);
          }
        }}
        onDoubleClick={() => {
          if (!isRenaming) {
            onSessionDoubleClick?.(session);
          }
        }}
        onContextMenu={(event) => {
          if (isRenaming || !onContextMenu) return;
          event.preventDefault();
          onContextMenu(event, 'chat', session.id, session.collectionId ?? null);
        }}
        data-session-id={session.id}
        data-item-id={session.id}
        data-testid={`collection-chat-${session.id}`}
      >
        <span className="relative flex shrink-0 items-center">
          <MessageSquare className="h-3.5 w-3.5 text-(--text-muted) opacity-45" />
          <ItemStatusIndicator
            isProcessing={isProcessing}
            isAwaitingUser={isAwaitingUser}
            hasUnread={hasUnread}
            isRunning={liveIsRunning}
            placement="corner"
            surface="sidebar"
          />
        </span>

        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <InlineRenameInput
              inputRef={renameInputRef}
              value={renameValue}
              onValueChange={setRenameValue}
              onConfirm={confirmRename}
              onCancel={cancelRename}
              className="w-full border-b border-(--accent) bg-transparent text-[0.8125rem] font-medium text-(--sidebar-text-active) outline-none caret-(--accent)"
            />
          ) : (
            <span
              className={cn(
                'block truncate text-[0.8125rem] font-medium leading-snug text-(--sidebar-text-active)',
                isGeneratingTitle && 'title-generating'
              )}
              style={
                isGeneratingTitle
                  ? { ...titleFadeStyle, ...getTitleGeneratingStyle(session.id) }
                  : titleFadeStyle
              }
            >
              {session.title}
            </span>
          )}
        </div>

        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 flex items-start justify-end rounded-r-lg pr-1.5 pt-1.5 transition-opacity duration-150',
            liveIsRunning ? 'w-28' : 'w-24',
            isHovered && !isRenaming ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-full rounded-r-lg"
            style={hoverActionFadeStyle}
          />
          <div className="relative flex pointer-events-auto items-center gap-0.5">
            {liveIsRunning && onStopProcess && (
              <StopProcessButton
                onClick={handleStopProcess}
                className="rounded p-1 text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
                testId={`collection-chat-quick-stop-${session.id}`}
              />
            )}
            {onArchive && (
              <ArchiveConfirmButton
                isConfirming={isConfirmingArchive}
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  handleArchiveClick();
                }}
                className={cn(
                  'rounded p-1 transition-all duration-150',
                  isConfirmingArchive
                    ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-(--success)'
                    : 'text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:text-(--accent)',
                )}
                testId={`collection-chat-quick-archive-${session.id}`}
                confirmTitle="Click again to archive"
                idleTitle="Archive"
              />
            )}
            <OverflowMenuButton
              buttonRef={moreButtonRef}
              onClick={(event) => {
                event.stopPropagation();
                if (onContextMenu) {
                  onContextMenu(event, 'chat', session.id, session.collectionId ?? null);
                }
              }}
              className="text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)"
            />
          </div>
        </div>
      </div>
      {dropIndicatorAfter && (
        <div className="mx-3 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
    </>
  );
}
