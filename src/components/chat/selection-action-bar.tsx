'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Archive, CheckCircle2, CircleStop, LayoutGrid, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSelectionStore } from '@/stores/selection-store';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

/**
 * Floating action menu shown beside the last session selected with Ctrl/Cmd+Click.
 * The vertical menu keeps every action legible without stretching across the workspace.
 */

const BAR_GAP = 8;
const VIEWPORT_PADDING = 8;
const MENU_WIDTH = 224;
const MENU_HEIGHT = 238;

function computePosition(anchorEl: Element): { top: number; left: number } {
  const rect = anchorEl.getBoundingClientRect();
  let left = rect.right + BAR_GAP;
  let top = rect.top + rect.height / 2 - MENU_HEIGHT / 2;

  if (left + MENU_WIDTH > window.innerWidth - VIEWPORT_PADDING) {
    left = rect.left - MENU_WIDTH - BAR_GAP;
  }

  left = Math.max(VIEWPORT_PADDING, left);
  top = Math.max(
    VIEWPORT_PADDING,
    Math.min(top, window.innerHeight - MENU_HEIGHT - VIEWPORT_PADDING),
  );

  return { top, left };
}

interface SelectionActionBarContentProps {
  selectedCount: number;
  position: { top: number; left: number };
  clearSelection: () => void;
  bulkMarkDone: () => void;
  bulkArchive: () => void;
  bulkStop: () => void;
  bulkDelete: () => void;
  openInSplitView: () => void;
  contentRef: RefObject<HTMLDivElement | null>;
}

function SelectionActionBarContent({
  selectedCount,
  position,
  clearSelection,
  bulkMarkDone,
  bulkArchive,
  bulkStop,
  bulkDelete,
  openInSplitView,
  contentRef,
}: SelectionActionBarContentProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    bulkDelete();
    setConfirmDelete(false);
  }, [confirmDelete, bulkDelete]);

  const menuItemClass = cn(
    'flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-3 text-left text-[12px] font-medium',
    'text-(--text-secondary) transition-colors',
    'hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
    'focus:bg-(--sidebar-hover) focus:text-(--text-primary) focus:outline-none',
  );

  return createPortal(
    <div
      ref={contentRef}
      style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
      className={cn(
        'fixed z-[9998] rounded-xl border border-(--divider) bg-(--sidebar-bg) p-1.5',
        'shadow-[0_12px_36px_rgba(0,0,0,0.32),0_2px_8px_rgba(0,0,0,0.2)]',
        'animate-in fade-in zoom-in-95 duration-150',
      )}
      role="menu"
      aria-label="Selected session actions"
      data-testid="selection-action-bar"
    >
      <div className="flex h-8 items-center justify-between px-2">
        <span className="text-[12px] font-semibold text-(--text-primary) tabular-nums">
          {selectedCount}
          <span className="ml-1 font-normal text-(--text-muted)">selected</span>
        </span>
        <button
          {...telemetryClickAttributes('list.selection.clear', 'workspace_list')}
          onClick={clearSelection}
          className="rounded-md p-1 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          data-testid="bulk-clear"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mx-1 mb-1 h-px bg-(--divider) opacity-60" />

      <button
        {...telemetryClickAttributes('list.selection.done', 'workspace_list')}
        onClick={bulkMarkDone}
        className={cn(menuItemClass, 'text-(--success)')}
        role="menuitem"
        data-testid="bulk-mark-done"
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>Mark as Done</span>
      </button>

      <button
        {...telemetryClickAttributes('list.selection.open_split_view', 'workspace_list')}
        onClick={openInSplitView}
        className={menuItemClass}
        role="menuitem"
        data-testid="bulk-open-split-view"
      >
        <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
        <span>Open in Split View</span>
      </button>

      <button
        {...telemetryClickAttributes('list.selection.stop', 'workspace_list')}
        onClick={bulkStop}
        className={cn(
          menuItemClass,
          'text-(--error) hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
        )}
        role="menuitem"
        data-testid="bulk-stop"
      >
        <CircleStop className="h-3.5 w-3.5 shrink-0" />
        <span>Stop Sessions</span>
      </button>

      <div className="mx-1 my-1 h-px bg-(--divider) opacity-60" />

      <button
        {...telemetryClickAttributes('list.selection.archive', 'workspace_list')}
        onClick={bulkArchive}
        className={menuItemClass}
        role="menuitem"
        data-testid="bulk-archive"
      >
        <Archive className="h-3.5 w-3.5 shrink-0" />
        <span>Archive</span>
      </button>

      <button
        {...telemetryClickAttributes('list.selection.delete', 'workspace_list')}
        onClick={handleDelete}
        className={cn(
          menuItemClass,
          confirmDelete
            ? 'bg-(--error) text-white hover:bg-[color-mix(in_srgb,var(--error)_85%,black)] hover:text-white'
            : 'text-(--error) hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
        )}
        role="menuitem"
        data-testid="bulk-delete"
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        <span>{confirmDelete ? 'Confirm Delete' : 'Delete'}</span>
      </button>
    </div>,
    document.body,
  );
}

export function SelectionActionBar() {
  const selectedCount = useSelectionStore((state) => state.selectedIds.size);
  const barAnchorId = useSelectionStore((state) => state.barAnchorId);
  const clearSelection = useSelectionStore((state) => state.clearSelection);
  const bulkMarkDone = useSelectionStore((state) => state.bulkMarkDone);
  const bulkArchive = useSelectionStore((state) => state.bulkArchive);
  const bulkStop = useSelectionStore((state) => state.bulkStop);
  const bulkDelete = useSelectionStore((state) => state.bulkDelete);
  const openInSplitView = useSelectionStore((state) => state.openInSplitView);
  const contentRef = useRef<HTMLDivElement>(null);
  const position = useMemo(() => {
    if (!barAnchorId || selectedCount === 0 || typeof document === 'undefined') return null;

    const el = document.querySelector(`[data-session-id="${CSS.escape(barAnchorId)}"]`);
    return el ? computePosition(el) : null;
  }, [barAnchorId, selectedCount]);

  useEffect(() => {
    if (selectedCount === 0) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"], [data-state="open"]')) return;
      clearSelection();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedCount, clearSelection]);

  useEffect(() => {
    if (selectedCount === 0) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (contentRef.current?.contains(target)) return;
      if (target.closest('[data-session-id]')) return;
      clearSelection();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [selectedCount, clearSelection]);

  if (selectedCount === 0 || typeof document === 'undefined' || !position) return null;

  return (
    <SelectionActionBarContent
      key={`${barAnchorId}:${selectedCount}`}
      selectedCount={selectedCount}
      position={position}
      clearSelection={clearSelection}
      bulkMarkDone={bulkMarkDone}
      bulkArchive={bulkArchive}
      bulkStop={bulkStop}
      bulkDelete={bulkDelete}
      openInSplitView={openInSplitView}
      contentRef={contentRef}
    />
  );
}
