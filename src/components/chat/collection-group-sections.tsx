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
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useArchiveConfirm } from '@/hooks/use-archive-confirm';
import { useInlineRename } from '@/hooks/use-inline-rename';
import { useSubSessionCap } from '@/hooks/use-sub-session-cap';
import { useSubSessionReorder } from '@/hooks/use-sub-session-reorder';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import {
  useAnyProjectViewSessionUnread,
  useProjectViewSessionUnread,
} from '@/hooks/use-project-view-session-unread';
import {
  useProjectViewSession,
  useProjectViewSessions,
} from '@/hooks/use-project-view-workspace-state';
import { setPanelSessionDragData } from '@/lib/dnd/panel-session-drag';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBoardStore } from '@/stores/board-store';
import {
  useAnySessionAwaitingUser,
  useIsSessionAwaitingUser,
} from '@/hooks/use-session-awaiting-user';
import { useCollectionStore } from '@/stores/collection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { COLLECTION_ITEM_DND_MIME, SIDEBAR_STATUS_GROUP_CONFIG, SIDEBAR_STATUS_GROUP_ORDER } from '@/types/task';
import { CHAT_WORKFLOW_ICON_COLOR, CHAT_WORKFLOW_ICON_FILL } from '@/types/task-entity';
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
  WorkflowMessageSquareIcon,
} from './work-item-primitives';
import { CollectionMoveSubmenu } from './collection-move-submenu';
import { DiffStatsBadge } from './diff-stats-badge';
import { TaskPreparationBadge } from '@/components/task/task-preparation-view';
import { ProviderLogoMark } from './provider-brand';
import { ProviderQuickMenu } from './provider-quick-menu';
import { detectPrMismatch, prMismatchTooltip } from './task-pr-badge';
import { getTitleGeneratingStyle } from '@/lib/title-generating-style';
import {
  useIsSessionProcessing,
  useSessionProcessingSummary,
} from '@/hooks/use-session-processing';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import {
  SIDEBAR_TREE_LEADING_SLOT,
  SIDEBAR_TREE_ROW_GUTTER,
  SIDEBAR_TREE_WORKTREE_CHILD_BRANCH,
  SIDEBAR_TREE_WORKTREE_CHILD_CONNECTOR_OFFSET,
} from './sidebar-tree-layout';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import {
  getLinkedWorktreeDensity,
  isLinkedWorktreeParentActive,
  toLinkedWorktreeSession,
} from '@/lib/worktrees/linked-worktree-presentation';
import { stepAsidePhoneSidebar } from '@/lib/viewport/phone-overlay-step-aside';
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';
import { resolvePreparationBadge } from '@/lib/projects/preparation-status-policy';
import { isSpecialSession } from '@/lib/constants/special-sessions';
import { captureTelemetryUiControl } from '@/lib/telemetry/client';

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

const COLLECTION_PROVIDER_MARK_CLASS = 'h-3.5 w-3.5 rounded-[3px]';
const COLLECTION_PROVIDER_ICON_CLASS = 'h-2 w-2';

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

    // A phone tap synthesises pointerdown → mousedown → mouseup → click all in
    // one tick. If we register on the leading edge of that sequence, the very
    // click that just opened the menu is also seen as an outside mousedown and
    // the menu snaps shut before the user ever sees it. Deferring by a frame
    // lets the opening cycle drain first.
    const raf = window.requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleMouseDown, true);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', handleMouseDown, true);
    };
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
        telemetryControl="collection.menu.open"
        telemetrySurface="workspace_list"
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
            {...telemetryClickAttributes('collection.edit', 'workspace_list')}
            onClick={handleEdit}
            className="flex w-full items-center gap-2 px-3 h-8 text-[0.75rem] text-left rounded-md text-(--sidebar-text-active) transition-colors hover:bg-(--sidebar-hover) cursor-default"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Edit</span>
          </button>
          <button
            {...telemetryClickAttributes('collection.delete', 'workspace_list')}
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
  projectViewId,
  collections,
  onClose,
  onRename,
  onDelete,
  onArchive,
  onOpenInNewTab,
  onGenerateTitle,
  onStopProcess,
  onStatusChange,
  onRunPreparation,
}: {
  menu: ContextMenuState;
  projectViewId: string;
  collections?: Collection[];
  onClose: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onOpenInNewTab?: () => void;
  onGenerateTitle?: () => void;
  onStopProcess?: () => void;
  onStatusChange?: (status: string) => void;
  /** Runs the project's preparation script again on this task's worktree. */
  onRunPreparation?: () => void;
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

      await useTaskStore.getState().updateTask(menu.targetId, { collectionId }, projectViewId);
    },
    [menu, onClose, projectViewId],
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
              {...telemetryClickAttributes('task.stop', 'workspace_list')}
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
            {SIDEBAR_STATUS_GROUP_ORDER.filter((s) => menu.type === 'chat' && !menu.isSubSession ? true : s !== 'chat').map((status) => {
              const config = SIDEBAR_STATUS_GROUP_CONFIG[status];
              const isCurrent = status === menu.currentStatus;
              return (
                <button
                  key={status}
                  {...telemetryClickAttributes('task.status.change', 'workspace_list')}
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
          <button
            {...telemetryClickAttributes('task.generate_title', 'workspace_list')}
            className={menuItemClass}
            onClick={() => { onGenerateTitle(); onClose(); }}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>{t('task.contextMenu.generateTitle' as Parameters<typeof t>[0])}</span>
          </button>
        )}

        {onRunPreparation && (
          <button
            {...telemetryClickAttributes('task.run_preparation', 'workspace_list')}
            className={menuItemClass}
            onClick={() => { onRunPreparation(); onClose(); }}
            data-testid="ctx-run-preparation"
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>{t('task.preparation.runNow')}</span>
          </button>
        )}

        {onRename && (
          <button
            {...telemetryClickAttributes('task.rename', 'workspace_list')}
            className={menuItemClass}
            onClick={() => { onRename(); onClose(); }}
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Rename</span>
          </button>
        )}

        {onArchive && (
          <button
            {...telemetryClickAttributes('task.archive_toggle', 'workspace_list')}
            className={menuItemClass}
            onClick={() => { onArchive(); onClose(); }}
            data-testid={menu.type === 'task' && !menu.isSubSession
              ? 'ctx-archive-worktree-task'
              : 'ctx-archive-session'}
          >
            <Archive className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>{menu.type === 'task' && !menu.isSubSession
              ? 'Archive worktree task'
              : 'Archive session'}</span>
          </button>
        )}

        {onOpenInNewTab && (
          <button
            {...telemetryClickAttributes('task.open_new_tab', 'workspace_list')}
            className={menuItemClass}
            onClick={() => { onOpenInNewTab(); onClose(); }}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
            <span>Open in New Tab</span>
          </button>
        )}

        {onDelete && (
          <>
            <div className="mx-2 my-1 h-px bg-(--divider) opacity-40" />
            <button
              {...telemetryClickAttributes('task.delete', 'workspace_list')}
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
  task,
  activeSessionId,
  collectionId,
  onSessionClick,
  onSessionDoubleClick,
  onContextMenu,
  onStopProcess,
  onArchive,
  onRename,
  isRenameRequested,
  onRenameComplete,
  reorder,
}: {
  sess: TaskSession;
  task: TaskEntity;
  activeSessionId: string | null;
  collectionId: string | null;
  reorder?: ReturnType<typeof useSubSessionReorder>;
  onSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => void;
  onSessionDoubleClick?: (session: UnifiedSession) => void;
  onContextMenu?: ItemContextMenuHandler;
  onStopProcess?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onRename?: (sessionId: string, newTitle: string) => void;
  isRenameRequested?: boolean;
  onRenameComplete?: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const isActive = sess.id === activeSessionId;
  const isSelected = useSelectionStore((state) => state.selectedIds.has(sess.id));
  const showProviderIcons = useSettingsStore((state) => state.settings.showProviderIcons);
  const isProcessing = useIsSessionProcessing(sess.id, sess.kind);
  const isAwaitingUser = useIsSessionAwaitingUser(sess.id, sess.kind);
  const liveSession = useProjectViewSession(sess.id, task.projectViewId);
  const runtimePresentation = resolveSessionRuntimePresentation({
    kind: liveSession?.kind ?? sess.kind,
    isRunning: liveSession?.isRunning ?? sess.isRunning,
  });
  const hasCanonicalUnread = useProjectViewSessionUnread(sess.id);
  const hasUnread = !isActive && hasCanonicalUnread;
  const asUnifiedSession = useCallback(
    () => toLinkedWorktreeSession(task, sess, liveSession),
    [liveSession, sess, task],
  );
  const openSession = useCallback(() => {
    return asUnifiedSession();
  }, [asUnifiedSession]);
  const handleStopProcess = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    onStopProcess?.(sess.id);
  }, [onStopProcess, sess.id]);
  const {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  } = useArchiveConfirm(() => onArchive?.(sess.id));
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
    reorder?.handleDragStart(sess.id);
  }, [isRenaming, sess.id, reorder]);

  const dropPosition = reorder?.indicatorFor(sess.id) ?? null;

  return (
    <div
      className={cn(
        'group/sub relative my-px flex items-center gap-1.5 rounded px-2 py-1 text-[0.75rem] transition-colors duration-150',
        isRenaming ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
        reorder?.draggingSessionId === sess.id && 'opacity-40',
        isSelected
          ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--sidebar-text-active) ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
          : isActive
            ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-(--sidebar-text-active) ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
            : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
      )}
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onDragEnd={(event) => {
        event.stopPropagation();
        reorder?.handleDragEnd();
      }}
      onDragOver={(event) => reorder?.handleDragOver(event, sess.id)}
      onDrop={(event) => reorder?.handleDrop(event, sess.id)}
      onMouseEnter={() => setIsHovered(true)}
      data-telemetry-ignore="manual_capture"
      onMouseLeave={() => {
        setIsHovered(false);
        resetArchiveConfirm();
      }}
      onClick={(event) => {
        if (isRenaming) return;
        event.stopPropagation();
        void captureTelemetryUiControl('list.subsession.open', 'workspace_list');
        onSessionClick(openSession(), event);
      }}
      onDoubleClick={(event) => {
        if (isRenaming) return;
        event.stopPropagation();
        onSessionDoubleClick?.(openSession());
      }}
      onContextMenu={(event) => {
        if (isRenaming) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event, 'chat', sess.id, collectionId, true);
      }}
      data-session-id={sess.id}
      data-testid={`collection-subsession-${sess.id}`}
      data-drop-position={dropPosition ?? undefined}
    >
      {dropPosition && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-(--accent)',
            dropPosition === 'before' ? '-top-px' : '-bottom-px',
          )}
        />
      )}
      <div className={cn(
        'absolute top-1/2 h-px w-[10px] bg-(--divider)',
        SIDEBAR_TREE_WORKTREE_CHILD_CONNECTOR_OFFSET,
      )} />
      {isActive && (
        <div className={cn(
          'absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-(--accent)',
          SIDEBAR_TREE_WORKTREE_CHILD_CONNECTOR_OFFSET,
        )} />
      )}
      {showProviderIcons ? (
        <span className="relative flex shrink-0 items-center">
          <ProviderLogoMark
            providerId={sess.provider}
            className={COLLECTION_PROVIDER_MARK_CLASS}
            iconClassName={COLLECTION_PROVIDER_ICON_CLASS}
            data-testid={`collection-subsession-agent-icon-${sess.id}`}
          />
          <ItemStatusIndicator
            isProcessing={isProcessing}
            isAwaitingUser={isAwaitingUser}
            hasUnread={hasUnread}
            isRunning={runtimePresentation.showRunning}
            sessionKind={liveSession?.kind ?? sess.kind}
            placement="corner"
            surface="sidebar"
          />
        </span>
      ) : (
        <span className="relative flex w-1.5 shrink-0 items-center">
          <ItemStatusIndicator
            isProcessing={isProcessing}
            isAwaitingUser={isAwaitingUser}
            hasUnread={hasUnread}
            isRunning={runtimePresentation.showRunning}
            sessionKind={liveSession?.kind ?? sess.kind}
            placement="leading"
            surface="sidebar"
          />
        </span>
      )}

      {isRenaming ? (
        <InlineRenameInput
          telemetrySurface="workspace_list"
          inputRef={renameInputRef}
          value={renameValue}
          onValueChange={setRenameValue}
          onConfirm={confirmRename}
          onCancel={cancelRename}
          className="min-w-0 flex-1 border-b border-(--accent) bg-transparent text-[0.75rem] text-(--sidebar-text-active) outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{sess.title}</span>
      )}

      {!isRenaming && (
        // Row actions.
        // Desktop: hover-reveal — stop / archive / kebab appear together.
        // Phone: stop and archive collapse into the kebab menu (which already
        // carries them via onContextMenu), and the kebab itself is always
        // visible. Hover on touch is unreliable and, when it does fire on tap,
        // races the row's own onClick that opens the session.
        <div className="flex shrink-0 items-center gap-0.5 sm:absolute sm:inset-y-0 sm:right-2 sm:z-10">
          {runtimePresentation.canStop && onStopProcess && (
            <StopProcessButton
              telemetryControl="task.stop"
              telemetrySurface="workspace_list"
              onClick={handleStopProcess}
              className={cn(
                'max-sm:hidden rounded p-0.5 text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90',
                isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
              )}
              testId={`collection-subsession-quick-stop-${sess.id}`}
            />
          )}
          {onArchive && (
            <ArchiveConfirmButton
              telemetryControl="task.archive_toggle"
              telemetrySurface="workspace_list"
              isConfirming={isConfirmingArchive}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                handleArchiveClick();
              }}
              className={cn(
                'max-sm:hidden rounded p-0.5 transition-all duration-150',
                isConfirmingArchive
                  ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-(--success)'
                  : 'text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:text-(--accent)',
                isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
              )}
              testId={`collection-subsession-quick-archive-${sess.id}`}
              confirmTitle="Click again to archive"
              idleTitle="Archive"
            />
          )}
          <OverflowMenuButton
            telemetryControl="task.menu.open"
            telemetrySurface="workspace_list"
            buttonRef={moreRef}
            onClick={(event) => {
              event.stopPropagation();
              onContextMenu?.(event, 'chat', sess.id, collectionId, true);
            }}
            size="compact"
            className={cn(
              'shrink-0 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
              // Always available on phone; desktop keeps the hover-reveal.
              'max-sm:opacity-100',
              isHovered ? 'sm:opacity-100' : 'sm:opacity-0 sm:pointer-events-none',
            )}
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
  onSessionArchive,
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
  /** Archives a single child session, leaving the task and its worktree alone. */
  onSessionArchive?: (sessionId: string, task?: TaskEntity) => void;
  renamingSessionId?: string | null;
  isRenameRequested?: boolean;
  onRenameComplete?: () => void;
  onAddSession: (providerId?: string, executionMode?: AgentExecutionMode) => void;
  onStopProcess?: (sessionId: string) => void;
  disableDnd?: boolean;
  allowPanelSessionDnd?: boolean;
}) {
  const { t } = useI18n();
  const [isHovered, setIsHovered] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [providerMenuAnchor, setProviderMenuAnchor] = useState<DOMRect | null>(null);
  const showProviderIcons = useSettingsStore((state) => state.settings.showProviderIcons);
  const density = getLinkedWorktreeDensity(task.sessions);
  const isExpanded = density === 'expanded';
  const { visibleSessions, hiddenCount, showToggle, revealed, toggle } = useSubSessionCap(task.sessions);
  const subSessionReorder = useSubSessionReorder(task.id, task.sessions);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activePanelSessionId = usePanelStore((state) => {
    const tab = state.tabPanels[activeTabId];
    const sessionId = tab?.panels[tab.activePanelId]?.sessionId ?? null;
    return isSpecialSession(sessionId) ? null : sessionId;
  });
  const activePanelWorktreeId = usePanelStore((state) => {
    const tab = state.tabPanels[activeTabId];
    return tab?.panels[tab.activePanelId]?.worktreeId ?? null;
  });
  const peekWorktreeId = useWorkspacePeekStore((state) => state.target?.worktreeId ?? null);
  const isTaskActive = isLinkedWorktreeParentActive({
    density,
    primarySessionId: task.sessions[0]?.id ?? null,
    activeSessionId,
    taskWorktreeId: task.worktreeId ?? null,
    activePanelSessionId,
    activePanelWorktreeId,
    peekWorktreeId,
  });
  const isPending = task.isPending === true;
  const hasPreparationBadge = resolvePreparationBadge(
    task.preparationStatus ?? 'never_run',
  ) !== null;
  const primarySessionId = task.sessions[0]?.id;
  const isGeneratingTitle = useSessionStore((state) =>
    primarySessionId ? state.generatingTitleIds.has(primarySessionId) : false,
  );
  const isSelected = useSelectionStore((state) =>
    density === 'composite' && primarySessionId
      ? state.selectedIds.has(primarySessionId)
      : false,
  );
  const hoverActionFadeStyle = getSidebarHoverActionFadeStyle(
    getSidebarActionSurface({ isActive: isTaskActive, isSelected }),
  );
  const taskSessionIds = task.sessions.map((session) => session.id);
  const resolvedTaskSessions = useProjectViewSessions(taskSessionIds, task.projectViewId);
  const resolvedTaskSessionsById = new Map(
    resolvedTaskSessions.map((session) => [session.id, session]),
  );
  const hasVisibleRuntimeSession = taskSessionIds.some((id) => {
    const snapshot = task.sessions.find((session) => session.id === id);
    const session = resolvedTaskSessionsById.get(id) ?? snapshot;
    return session
      ? resolveSessionRuntimePresentation(session).showRunning
      : false;
  });
  const {
    hasProcessingSession,
    hasTerminalProcessingSession,
  } = useSessionProcessingSummary(task.sessions);
  const hasAwaitingUserSession = useAnySessionAwaitingUser(task.sessions);
  const hasCanonicalUnreadSession = useAnyProjectViewSessionUnread(
    taskSessionIds,
    activeSessionId,
  );
  const hasUnreadSession = !isTaskActive && hasCanonicalUnreadSession;
  const hasTaskStatus = hasProcessingSession || hasAwaitingUserSession || hasUnreadSession || hasVisibleRuntimeSession;
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
  const canPanelSessionDnd = Boolean(
    density === 'composite' && allowPanelSessionDnd && primarySessionId && !isRenaming && !isPending,
  );
  const canDrag = canCollectionDnd || canPanelSessionDnd;
  const titleFadeStyle: React.CSSProperties | undefined = isHovered && !isRenaming
    ? {
        WebkitMaskImage: hasVisibleRuntimeSession ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
        maskImage: hasVisibleRuntimeSession ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
      }
    : undefined;

  const handleArchive = useCallback(() => {
    void useTaskStore.getState().toggleTaskArchive(task.id, true);
  }, [task.id]);

  const {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  } = useArchiveConfirm(handleArchive);

  const handleStopProcess = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();

    for (const session of task.sessions) {
      const liveSession = projectViewWorkspaceState.resolveSession(
        session.id,
        task.projectViewId,
      );
      if (resolveSessionRuntimePresentation(liveSession ?? session).canStop) {
        onStopProcess?.(session.id);
      }
    }
  }, [onStopProcess, task.projectViewId, task.sessions]);

  const handleDragStart = useCallback((event: React.DragEvent) => {
    if (disableDnd) {
      event.stopPropagation();
      setPanelSessionDragData(event.dataTransfer, primarySessionId);
      event.dataTransfer.effectAllowed = 'move';
      return;
    }

    onDragStart(event);
  }, [disableDnd, onDragStart, primarySessionId]);

  const selectWorktree = useCallback(() => {
    if (!task.worktreeId) return;
    stepAsidePhoneSidebar();
    useWorkspacePeekStore.getState().openWorktree(task.worktreeId, task.projectViewId);
  }, [task.projectViewId, task.worktreeId]);

  const openPrimarySession = useCallback(async (
    open: (session: UnifiedSession) => void | Promise<void>,
  ) => {
    const session = task.sessions[0];
    if (!session) return;
    const unifiedSession = toLinkedWorktreeSession(task, session);
    await open(unifiedSession);
  }, [task]);

  const handleClick = useCallback(
    async (event: React.MouseEvent) => {
      if (isRenaming) return;
      if (density !== 'composite') {
        selectWorktree();
        return;
      }
      await openPrimarySession((session) => onSessionClick(session, event));
    },
    [density, isRenaming, onSessionClick, openPrimarySession, selectWorktree],
  );

  const handleDoubleClick = useCallback(async () => {
    if (isRenaming) return;
    if (density !== 'composite') {
      selectWorktree();
      return;
    }
    await openPrimarySession((session) => onSessionDoubleClick?.(session));
  }, [density, isRenaming, onSessionDoubleClick, openPrimarySession, selectWorktree]);

  // Worktree mark (git branch icon + PR-mismatch / missing badges). Rendered on
  // the leading side when provider icons are off (it's the task's primary mark),
  // or trailing when provider icons are on — keeping the leading slot a single
  // icon so task titles align with chat titles. `showStatus` attaches the
  // status dot; only the leading placement carries it (trailing gets it on the
  // provider mark instead).
  const renderWorktreeMark = (showStatus: boolean, className?: string, Icon: LucideIcon = FolderGit2) => {
    if (!task.worktreeId && !task.worktreeBranch) return null;
    const branchLabel = task.worktreeBranch ?? 'unknown';
    return (
      <span
        title={task.worktreeMissing ? t('task.worktree.missing', { branch: branchLabel }) : branchLabel}
        className={cn('relative flex shrink-0 items-center', className)}
        data-testid={`collection-task-worktree-icon-${task.id}`}
      >
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            task.worktreeMissing
              ? 'text-(--status-error-text) opacity-70'
              : getWorktreeIconClass(task.workflowStatus),
          )}
        />
        {(() => {
          // Skip mismatch badge when PR sync is unsupported — we have no
          // reliable prStatus to compare against the column.
          const mismatch = task.prUnsupported || task.prStatusKnown === false
            ? null
            : detectPrMismatch(task.workflowStatus, task.prStatus);
          if (!mismatch) return null;
          const reason = prMismatchTooltip(mismatch, task.prStatus?.number, t);
          return (
            <span
              title={reason}
              aria-label={reason}
              className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--status-error-text) ring-1 ring-(--sidebar-bg) cursor-help"
              data-testid="task-pr-mismatch-badge"
            />
          );
        })()}
        {showStatus && (
          <ItemStatusIndicator
            isProcessing={hasProcessingSession}
            isAwaitingUser={hasAwaitingUserSession}
            hasUnread={hasUnreadSession}
            isRunning={hasVisibleRuntimeSession}
            sessionKind={hasTerminalProcessingSession ? 'terminal' : undefined}
            placement="corner"
            surface="sidebar"
          />
        )}
        {task.worktreeMissing && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-(--status-error-text) ring-1 ring-(--sidebar-bg)"
          />
        )}
      </span>
    );
  };

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
          'group/task relative flex select-none items-center gap-2 rounded-lg py-1.5 transition-all duration-150 max-sm:pr-14',
          SIDEBAR_TREE_ROW_GUTTER,
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
        data-telemetry-ignore="manual_capture"
        onClick={isPending ? undefined : (event) => {
          void captureTelemetryUiControl('list.task.open', 'workspace_list');
          handleClick(event);
        }}
        onDoubleClick={isPending ? undefined : handleDoubleClick}
        onContextMenu={(event) => {
          if (isPending || isRenaming || !onContextMenu) return;
          event.preventDefault();
          onContextMenu(event, 'task', task.id, task.collectionId ?? null);
        }}
        data-session-id={task.sessions[0]?.id}
        data-worktree-id={task.worktreeId}
        data-linked-worktree-density={density}
        aria-current={isTaskActive ? 'true' : undefined}
        data-testid={`collection-task-${task.id}`}
      >
        {/* Pending, preparation, and ready states share one slot so the title stays put. */}
        <span className={SIDEBAR_TREE_LEADING_SLOT}>
          {hasPreparationBadge ? (
            <TaskPreparationBadge
              status={task.preparationStatus}
              presentation="icon"
            />
          ) : showProviderIcons && primarySessionId ? (
            <span className="relative flex shrink-0 items-center">
              <ProviderLogoMark
                providerId={task.sessions[0]?.provider}
                className={COLLECTION_PROVIDER_MARK_CLASS}
                iconClassName={COLLECTION_PROVIDER_ICON_CLASS}
                data-testid={`collection-task-agent-icon-${task.id}`}
              />
              <ItemStatusIndicator
                isProcessing={hasProcessingSession}
                isAwaitingUser={hasAwaitingUserSession}
                hasUnread={hasUnreadSession}
                isRunning={hasVisibleRuntimeSession}
                sessionKind={hasTerminalProcessingSession ? 'terminal' : undefined}
                placement="corner"
                surface="sidebar"
              />
            </span>
          ) : task.worktreeId || task.worktreeBranch ? (
            renderWorktreeMark(true)
          ) : hasTaskStatus ? (
            <span className="relative flex w-3.5 shrink-0 items-center justify-center">
              <ItemStatusIndicator
                isProcessing={hasProcessingSession}
                isAwaitingUser={hasAwaitingUserSession}
                hasUnread={hasUnreadSession}
                isRunning={hasVisibleRuntimeSession}
                sessionKind={hasTerminalProcessingSession ? 'terminal' : undefined}
                placement="inline"
                surface="sidebar"
              />
            </span>
          ) : null}
        </span>

        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <InlineRenameInput
              telemetrySurface="workspace_list"
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

        {/* Diff stats + worktree mark grouped tight on the trailing edge: a
            single gap to the title, minimal internal spacing, so the title keeps
            as much width as possible. Worktree stays pinned last so it never
            shifts when the diff appears or changes digit count. */}
        {!isRenaming && (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 transition-opacity duration-150',
              isHovered ? 'opacity-0' : 'opacity-100',
            )}
          >
            <DiffStatsBadge stats={task.diffStats} className="max-sm:hidden" />
            {showProviderIcons && renderWorktreeMark(false)}
          </span>
        )}

        <div
          className={cn(
            // Desktop keeps hover-reveal. Phone forces the action rail visible
            // and pointer-active so the + and kebab are always reachable — hover
            // on touch is unreliable and, when it fires from a tap, races the
            // row's own onClick that opens the session. Stop/archive drop into
            // the kebab menu on phone (see max-sm:hidden below).
            'absolute inset-y-0 right-0 flex items-start justify-end rounded-r-lg pr-1.5 pt-1.5 transition-opacity duration-150',
            hasVisibleRuntimeSession ? 'w-28' : 'w-24',
            'max-sm:opacity-100 max-sm:pointer-events-auto',
            isHovered && !isRenaming
              ? 'sm:opacity-100 sm:pointer-events-auto'
              : 'sm:opacity-0 sm:pointer-events-none',
          )}
        >
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-full rounded-r-lg max-sm:hidden"
            style={hoverActionFadeStyle}
          />
          <div className="relative flex pointer-events-auto items-center gap-0.5">
            {hasVisibleRuntimeSession && onStopProcess && (
              <StopProcessButton
                telemetryControl="task.stop"
                telemetrySurface="workspace_list"
                onClick={handleStopProcess}
                className="max-sm:hidden rounded p-1 text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
                testId={`collection-task-quick-stop-${task.id}`}
              />
            )}
            <ArchiveConfirmButton
              telemetryControl="task.archive_toggle"
              telemetrySurface="workspace_list"
              isConfirming={isConfirmingArchive}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                handleArchiveClick();
              }}
              className={cn(
                'max-sm:hidden rounded p-1 transition-all duration-150',
                isConfirmingArchive
                  ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-(--success)'
                  : 'text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] hover:text-(--accent)',
              )}
              testId={`collection-task-quick-archive-${task.id}`}
              confirmTitle="Click again to archive worktree task"
              idleTitle="Archive worktree task"
            />
            <button
              ref={addButtonRef}
              {...telemetryClickAttributes('list.task.add_session', 'workspace_list')}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                // Always open the menu — even with a single provider the session
                // still needs its PTY/GUI choice.
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
              telemetryControl="task.menu.open"
              telemetrySurface="workspace_list"
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

      {isExpanded && (
        <div
          className={cn('relative', SIDEBAR_TREE_WORKTREE_CHILD_BRANCH)}
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
          {visibleSessions.map((session) => (
            <SubSessionRow
              key={session.id}
              sess={session}
              task={task}
              activeSessionId={activeSessionId}
              collectionId={task.collectionId ?? null}
              onSessionClick={onSessionClick}
              onSessionDoubleClick={onSessionDoubleClick}
              onContextMenu={onContextMenu}
              onStopProcess={onStopProcess}
              onArchive={(sessionId) => onSessionArchive?.(sessionId, task)}
              onRename={onSessionRename}
              isRenameRequested={renamingSessionId === session.id}
              onRenameComplete={onRenameComplete}
              reorder={subSessionReorder}
            />
          ))}
          {showToggle && (
            <button
              {...telemetryClickAttributes('collection.subsessions.toggle', 'workspace_list')}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggle();
              }}
              className="w-full px-2 py-1 text-left text-[0.6875rem] text-(--text-muted) hover:text-(--sidebar-text-active)"
              data-testid={`collection-task-show-more-${task.id}`}
            >
              {revealed ? t('task.showLess') : t('task.showMore', { count: hiddenCount })}
            </button>
          )}
        </div>
      )}

      {dropIndicatorAfter && (
        <div className="mx-3 h-0.5 rounded-full bg-(--accent) transition-opacity duration-100" />
      )}
      {providerMenuAnchor && (
        <ProviderQuickMenu
          anchorRect={providerMenuAnchor}
          currentProviderId={task.sessions[0]?.provider}
          onSelect={(providerId, executionMode) => onAddSession(providerId, executionMode)}
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
  const showProviderIcons = useSettingsStore((state) => state.settings.showProviderIcons);
  const [isHovered, setIsHovered] = useState(false);
  const isProcessing = useIsSessionProcessing(session.id, session.kind);
  const isAwaitingUser = useIsSessionAwaitingUser(session.id, session.kind);
  const liveSession = useProjectViewSession(session.id);
  const liveIsRunning = liveSession?.isRunning ?? session.isRunning;
  const runtimePresentation = resolveSessionRuntimePresentation({
    kind: liveSession?.kind ?? session.kind,
    isRunning: liveIsRunning,
  });
  const isGeneratingTitle = useSessionStore((state) => state.generatingTitleIds.has(session.id));
  const workflowStatus = session.workflowStatus;
  const workflowColor = workflowStatus
    ? CHAT_WORKFLOW_ICON_COLOR[workflowStatus]
    : null;
  const workflowIconFill = workflowStatus
    ? CHAT_WORKFLOW_ICON_FILL[workflowStatus]
    : null;
  // Desktop shows Git stats for chats backed by a changed worktree. Phone keeps
  // that badge hidden so the always-visible overflow action has enough room.
  const showTrailingDiff = !!session.diffStats && session.diffStats.changedFiles > 0;
  const showTrailingBubble = showProviderIcons;
  const hasCanonicalUnread = useProjectViewSessionUnread(session.id);
  const hasUnread = !isActive && hasCanonicalUnread;
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
        WebkitMaskImage: runtimePresentation.canStop ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
        maskImage: runtimePresentation.canStop ? TASK_TITLE_ACTION_MASK_WITH_STOP : TASK_TITLE_ACTION_MASK,
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
          'group/chat relative flex select-none items-center gap-2 rounded-lg py-1.5 transition-all duration-150 max-sm:pr-10',
          SIDEBAR_TREE_ROW_GUTTER,
          canDrag && 'cursor-grab',
          isSelected
            ? 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-(--sidebar-text-active) ring-1 ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]'
            : isActive
              ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-(--sidebar-text-active) ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
              : 'text-(--sidebar-text) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
          isDragging && 'cursor-grabbing opacity-35 scale-[0.97]',
          isJustDropped && 'drop-flash',
        )}
        data-telemetry-ignore="manual_capture"
        onClick={(event) => {
          if (!isRenaming) {
            void captureTelemetryUiControl('list.chat.open', 'workspace_list');
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
        <span className={cn('relative', SIDEBAR_TREE_LEADING_SLOT)}>
          {showProviderIcons ? (
            <ProviderLogoMark
              providerId={session.provider}
              className={COLLECTION_PROVIDER_MARK_CLASS}
              iconClassName={COLLECTION_PROVIDER_ICON_CLASS}
              data-testid={`collection-chat-agent-icon-${session.id}`}
            />
          ) : (
            workflowColor && workflowIconFill ? (
              <WorkflowMessageSquareIcon
                className="h-3.5 w-3.5 opacity-95"
                style={{ color: workflowColor }}
                fillColor={workflowIconFill}
                testId={`collection-chat-bubble-${session.id}`}
              />
            ) : (
              <MessageSquare
                className="h-3.5 w-3.5 text-(--text-secondary) opacity-80"
                data-testid={`collection-chat-bubble-${session.id}`}
              />
            )
          )}
          <ItemStatusIndicator
            isProcessing={isProcessing}
            isAwaitingUser={isAwaitingUser}
            hasUnread={hasUnread}
            isRunning={runtimePresentation.showRunning}
            sessionKind={liveSession?.kind ?? session.kind}
            placement="corner"
            surface="sidebar"
          />
        </span>

        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <InlineRenameInput
              telemetrySurface="workspace_list"
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

        {/* Desktop retains the worktree diff. When a provider logo occupies the
            leading slot, keep chat identity on the trailing edge as well. */}
        {!isRenaming && (showTrailingDiff || showTrailingBubble) && (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 transition-opacity duration-150',
              'max-sm:opacity-100',
              isHovered ? 'sm:opacity-0' : 'sm:opacity-100',
            )}
          >
            <DiffStatsBadge stats={session.diffStats} className="max-sm:hidden" />
            {showTrailingBubble && (
              workflowColor && workflowIconFill ? (
                <WorkflowMessageSquareIcon
                  className="h-3.5 w-3.5 opacity-95"
                  style={{ color: workflowColor }}
                  fillColor={workflowIconFill}
                  testId={`collection-chat-status-bubble-${session.id}`}
                />
              ) : (
                <MessageSquare
                  className="h-3.5 w-3.5 text-(--text-secondary) opacity-80"
                  data-testid={`collection-chat-status-bubble-${session.id}`}
                />
              )
            )}
          </span>
        )}

        <div
          className={cn(
            'absolute inset-y-0 right-0 flex items-start justify-end rounded-r-lg pr-1.5 pt-1.5 transition-opacity duration-150',
            runtimePresentation.canStop ? 'sm:w-28' : 'sm:w-24',
            'max-sm:w-10 max-sm:opacity-100 max-sm:pointer-events-auto',
            isHovered && !isRenaming
              ? 'sm:opacity-100 sm:pointer-events-auto'
              : 'sm:opacity-0 sm:pointer-events-none',
          )}
        >
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-full rounded-r-lg max-sm:hidden"
            style={hoverActionFadeStyle}
          />
          <div className="relative flex pointer-events-auto items-center gap-0.5">
            {runtimePresentation.canStop && onStopProcess && (
              <StopProcessButton
                telemetryControl="task.stop"
                telemetrySurface="workspace_list"
                onClick={handleStopProcess}
                className="max-sm:hidden rounded p-1 text-(--error) transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] active:scale-90"
                testId={`collection-chat-quick-stop-${session.id}`}
              />
            )}
            {onArchive && (
              <ArchiveConfirmButton
                telemetryControl="task.archive_toggle"
                telemetrySurface="workspace_list"
                isConfirming={isConfirmingArchive}
                onClick={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  handleArchiveClick();
                }}
                className={cn(
                  'max-sm:hidden rounded p-1 transition-all duration-150',
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
              telemetryControl="task.menu.open"
              telemetrySurface="workspace_list"
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
