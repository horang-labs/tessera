'use client';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, CircleStop, Pencil, Trash2, ExternalLink, FolderInput, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SIDEBAR_STATUS_GROUP_CONFIG, SIDEBAR_STATUS_GROUP_ORDER } from '@/types/task';
import type { Collection } from '@/types/collection';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { CollectionMoveSubmenu } from './collection-move-submenu';

export interface TaskContextMenuProps {
  anchorRect: DOMRect;
  currentStatus?: string;
  isArchived: boolean;
  isRunning?: boolean;
  collections?: Collection[];
  currentCollectionId?: string | null;
  onStatusChange?: (status: string) => void;
  onMoveToCollection?: (collectionId: string | null) => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenInNewTab?: () => void;
  onGenerateTitle?: () => void;
  onMoveToProject?: () => void;
  onStopProcess?: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 32;
const PADDING = 6;

export function TaskContextMenu({
  anchorRect,
  currentStatus,
  isArchived,
  isRunning,
  collections = [],
  currentCollectionId = null,
  onStatusChange,
  onMoveToCollection,
  onArchive,
  onUnarchive,
  onRename,
  onDelete,
  onOpenInNewTab,
  onGenerateTitle,
  onMoveToProject,
  onStopProcess,
  onClose,
}: TaskContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const hasArchiveAction = Boolean(onArchive && onUnarchive);

  useCloseOnEscape(onClose, { capture: true });

  const menuPos = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const statusCount = currentStatus && onStatusChange
      ? SIDEBAR_STATUS_GROUP_ORDER.filter((s) => s !== 'chat' && s !== currentStatus).length
      : 0;
    const optionalItems = (isRunning && onStopProcess ? 1 : 0)
      + (onMoveToCollection ? 1 : 0)
      + (onMoveToProject ? 1 : 0)
      + (onGenerateTitle ? 1 : 0)
      + (onOpenInNewTab ? 1 : 0);
    const statusSectionHeight = statusCount > 0 ? 20 + statusCount * ITEM_HEIGHT + 8 : 0;
    const stopProcessDividerHeight = isRunning && onStopProcess ? 8 : 0;
    const upperActionDividerHeight = onGenerateTitle || onMoveToCollection ? 8 : 0;
    const deleteDividerHeight = 8;
    const archiveItemCount = hasArchiveAction ? 1 : 0;
    const menuHeight = statusSectionHeight
      + ITEM_HEIGHT * (2 + archiveItemCount + optionalItems)
      + PADDING * 2
      + stopProcessDividerHeight
      + upperActionDividerHeight
      + deleteDividerHeight;

    let top = anchorRect.bottom + 4;
    let left = anchorRect.left;

    if (top + menuHeight > vh - 8) {
      top = anchorRect.top - menuHeight - 4;
    }
    if (left + MENU_WIDTH > vw - 8) {
      left = vw - MENU_WIDTH - 8;
    }
    if (left < 8) left = 8;

    return { top, left };
  }, [
    anchorRect,
    currentStatus,
    isRunning,
    onGenerateTitle,
    onMoveToCollection,
    onMoveToProject,
    onOpenInNewTab,
    onStatusChange,
    onStopProcess,
    hasArchiveAction,
  ]);

  useEffect(function handleOutsideClick() {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose]);

  useEffect(function focusFirstItem() {
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
  }, []);

  const menuItemClass = cn(
    'w-full flex items-center gap-2 px-3 h-8 text-[12px] text-left rounded-md',
    'text-(--sidebar-text-active) transition-colors',
    'hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
    'cursor-default'
  );

  const destructiveItemClass = cn(
    'w-full flex items-center gap-2 px-3 h-8 text-[12px] text-left rounded-md',
    'text-(--error) transition-colors',
    'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
    'focus:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus:outline-none',
    'cursor-default'
  );

  const handleMenuKeyDown = useMenuNavigation(menuRef);

  const handleStatusChange = useCallback((status: string) => {
    onClose();
    onStatusChange?.(status);
  }, [onClose, onStatusChange]);

  const handleArchiveToggle = useCallback(() => {
    if (!onArchive || !onUnarchive) return;
    if (isArchived) {
      onUnarchive();
    } else {
      onArchive();
    }
    onClose();
  }, [isArchived, onArchive, onClose, onUnarchive]);

  const handleRename = useCallback(() => {
    onRename();
    onClose();
  }, [onClose, onRename]);

  const handleDelete = useCallback(() => {
    onDelete();
    onClose();
  }, [onClose, onDelete]);

  const handleOpenInNewTab = useCallback(() => {
    onOpenInNewTab?.();
    onClose();
  }, [onClose, onOpenInNewTab]);

  const handleGenerateTitle = useCallback(() => {
    onGenerateTitle?.();
    onClose();
  }, [onClose, onGenerateTitle]);

  const handleMoveToCollection = useCallback((collectionId: string | null) => {
    onMoveToCollection?.(collectionId);
    onClose();
  }, [onClose, onMoveToCollection]);

  const handleMoveToProject = useCallback(() => {
    if (isRunning) return;
    onMoveToProject?.();
    onClose();
  }, [isRunning, onClose, onMoveToProject]);

  const handleStopProcess = useCallback(() => {
    onStopProcess?.();
    onClose();
  }, [onClose, onStopProcess]);

  if (typeof document === 'undefined' || !menuPos) return null;

  const otherStatuses = currentStatus && onStatusChange
    ? SIDEBAR_STATUS_GROUP_ORDER.filter((s) => s !== 'chat' && s !== currentStatus)
    : [];

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Task options"
      className={cn(
        'fixed z-[9999] min-w-[200px] rounded-lg p-1.5',
        'bg-(--sidebar-bg) border border-(--divider)',
        'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
      )}
      style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
      onKeyDown={handleMenuKeyDown}
      data-testid="task-context-menu"
    >
      {isRunning && onStopProcess && (
        <>
          <button
            role="menuitem"
            className={cn(
              'w-full flex items-center gap-2 px-3 h-8 text-[12px] text-left rounded-md',
              'text-(--error) transition-colors',
              'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
              'focus:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus:outline-none',
              'cursor-default'
            )}
            onClick={handleStopProcess}
            data-testid="ctx-stop-process"
          >
            <CircleStop className="w-3.5 h-3.5 shrink-0" />
            <span>Stop Process</span>
          </button>
          <div className="my-1 h-px bg-(--divider) opacity-40" />
        </>
      )}

      {otherStatuses.length > 0 && (
        <>
          <div className="px-2 pt-1 pb-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-(--text-muted) opacity-60">
              {t('task.contextMenu.setStatus' as Parameters<typeof t>[0])}
            </span>
          </div>
          {otherStatuses.map((status) => {
            const config = SIDEBAR_STATUS_GROUP_CONFIG[status];
            const labelKey = config.label as Parameters<typeof t>[0];
            return (
              <button
                key={status}
                role="menuitem"
                className={menuItemClass}
                onClick={() => handleStatusChange(status)}
                data-testid={`ctx-status-${status}`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: config.color }}
                />
                <span>{t(labelKey)}</span>
              </button>
            );
          })}

          <div className="my-1 h-px bg-(--divider) opacity-40" />
        </>
      )}

      {onGenerateTitle && (
        <button
          role="menuitem"
          className={menuItemClass}
          onClick={handleGenerateTitle}
          data-testid="ctx-generate-title"
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
          <span>{t('task.contextMenu.generateTitle' as Parameters<typeof t>[0])}</span>
        </button>
      )}

      {onMoveToCollection && (
        <CollectionMoveSubmenu
          collections={collections}
          currentCollectionId={currentCollectionId}
          onMoveToCollection={handleMoveToCollection}
          triggerClassName={menuItemClass}
          itemClassName={menuItemClass}
        />
      )}

      {(onGenerateTitle || onMoveToCollection) && (
        <div className="my-1 h-px bg-(--divider) opacity-40" />
      )}

      {hasArchiveAction && (
        <button
          role="menuitem"
          className={menuItemClass}
          onClick={handleArchiveToggle}
          data-testid="ctx-archive"
        >
          {isArchived ? (
            <>
              <ArchiveRestore className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
              <span>{t('task.contextMenu.unarchive' as Parameters<typeof t>[0])}</span>
            </>
          ) : (
            <>
              <Archive className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
              <span>{t('task.contextMenu.archive' as Parameters<typeof t>[0])}</span>
            </>
          )}
        </button>
      )}

      <button
        role="menuitem"
        className={menuItemClass}
        onClick={handleRename}
        data-testid="ctx-rename"
      >
        <Pencil className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
        <span>{t('task.contextMenu.rename' as Parameters<typeof t>[0])}</span>
      </button>

      {onOpenInNewTab && (
        <button
          role="menuitem"
          className={menuItemClass}
          onClick={handleOpenInNewTab}
          data-testid="ctx-open-new-tab"
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
          <span>{t('task.contextMenu.openInNewTab' as Parameters<typeof t>[0])}</span>
        </button>
      )}

      {onMoveToProject && (
        <button
          role="menuitem"
          className={cn(menuItemClass, isRunning && 'opacity-40 pointer-events-none')}
          onClick={handleMoveToProject}
          disabled={isRunning}
          title={isRunning ? t('task.contextMenu.cannotMoveRunning' as Parameters<typeof t>[0]) : undefined}
          data-testid="ctx-move-to-project"
        >
          <FolderInput className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
          <span>{t('task.contextMenu.moveToProject' as Parameters<typeof t>[0])}</span>
        </button>
      )}

      <div className="my-1 h-px bg-(--divider) opacity-40" />

      <button
        role="menuitem"
        className={destructiveItemClass}
        onClick={handleDelete}
        data-testid="ctx-delete"
      >
        <Trash2 className="w-3.5 h-3.5 shrink-0" />
        <span>{t('task.contextMenu.delete' as Parameters<typeof t>[0])}</span>
      </button>
    </div>,
    document.body
  );
}
