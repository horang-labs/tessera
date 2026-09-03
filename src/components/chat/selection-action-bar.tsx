'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Archive, CircleStop, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSelectionStore } from '@/stores/selection-store';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

/**
 * SelectionActionBar — floating bar that appears next to the last-clicked
 * session item when one or more sessions are selected via Ctrl/Cmd+Click.
 *
 * Positions itself to the right of the anchor element (context-menu style).
 * Falls back to left-side if there's no room on the right.
 */

const BAR_GAP = 8; // gap between anchor element and bar
const VIEWPORT_PADDING = 8;

function computePosition(anchorEl: Element): { top: number; left: number } {
  const rect = anchorEl.getBoundingClientRect();
  const barWidth = 290; // approximate max width
  const barHeight = 44;

  // Try right side first
  let left = rect.right + BAR_GAP;
  let top = rect.top + rect.height / 2 - barHeight / 2;

  // If overflows right, try left side
  if (left + barWidth > window.innerWidth - VIEWPORT_PADDING) {
    left = rect.left - barWidth - BAR_GAP;
  }

  // Clamp to viewport
  left = Math.max(VIEWPORT_PADDING, left);
  top = Math.max(VIEWPORT_PADDING, Math.min(top, window.innerHeight - barHeight - VIEWPORT_PADDING));

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

  return createPortal(
    <div
      ref={contentRef}
      style={{ top: position.top, left: position.left }}
      className={cn(
        'fixed z-[9998]',
        'flex items-center gap-1.5 px-2 py-1.5 rounded-xl',
        'bg-(--sidebar-bg) border border-(--divider)',
        'shadow-[0_8px_32px_rgba(0,0,0,0.3),0_2px_8px_rgba(0,0,0,0.2)]',
        'animate-in fade-in duration-150',
      )}
      data-testid="selection-action-bar"
    >
      <span className="px-1.5 text-[12px] font-semibold text-(--text-primary) whitespace-nowrap tabular-nums">
        {selectedCount}
        <span className="text-(--text-muted) font-normal ml-1">selected</span>
      </span>

      <div className="w-px h-5 bg-(--divider) mx-0.5" />

      <button
        {...telemetryClickAttributes('list.selection.done', 'workspace_list')}
        onClick={bulkMarkDone}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium',
          'bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
          'text-(--success) hover:bg-[color-mix(in_srgb,var(--success)_20%,transparent)]',
          'transition-colors whitespace-nowrap',
        )}
        data-testid="bulk-mark-done"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        Done
      </button>

      <button
        {...telemetryClickAttributes('list.selection.stop', 'workspace_list')}
        onClick={bulkStop}
        className={cn(
          'flex items-center justify-center size-7 rounded-md text-[12px] font-medium',
          'text-(--error) hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]',
          'transition-colors',
        )}
        aria-label="Stop selected sessions"
        title="Stop sessions"
        data-testid="bulk-stop"
      >
        <CircleStop className="w-3.5 h-3.5" />
      </button>

      <button
        {...telemetryClickAttributes('list.selection.archive', 'workspace_list')}
        onClick={bulkArchive}
        className={cn(
          'flex items-center justify-center size-7 rounded-md text-[12px] font-medium',
          'text-(--text-secondary) hover:bg-(--sidebar-hover)',
          'transition-colors',
        )}
        aria-label="Archive selected sessions"
        title="Archive sessions"
        data-testid="bulk-archive"
      >
        <Archive className="w-3.5 h-3.5" />
      </button>

      <button
        {...telemetryClickAttributes('list.selection.delete', 'workspace_list')}
        onClick={handleDelete}
        className={cn(
          'flex items-center justify-center size-7 rounded-md text-[12px] font-medium',
          'transition-colors whitespace-nowrap',
          confirmDelete
            ? 'bg-(--error) text-white hover:bg-[color-mix(in_srgb,var(--error)_85%,black)]'
            : 'text-(--error) hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]',
        )}
        aria-label={confirmDelete ? 'Confirm delete selected sessions' : 'Delete selected sessions'}
        title={confirmDelete ? 'Confirm delete' : 'Delete sessions'}
        data-testid="bulk-delete"
      >
        <Trash2 className="w-3.5 h-3.5" />
        {confirmDelete && <span className="sr-only">Confirm</span>}
      </button>

      <div className="w-px h-5 bg-(--divider) mx-0.5" />

      <button
        {...telemetryClickAttributes('list.selection.clear', 'workspace_list')}
        onClick={clearSelection}
        className={cn(
          'p-1.5 rounded-lg text-(--text-muted)',
          'hover:text-(--text-primary) hover:bg-(--sidebar-hover)',
          'transition-colors',
        )}
        aria-label="Clear selection"
        title="ESC"
        data-testid="bulk-clear"
      >
        <X className="w-4 h-4" />
      </button>
    </div>,
    document.body
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
  const contentRef = useRef<HTMLDivElement>(null);
  const position = useMemo(() => {
    if (!barAnchorId || selectedCount === 0 || typeof document === 'undefined') {
      return null;
    }

    const el = document.querySelector(`[data-session-id="${CSS.escape(barAnchorId)}"]`);
    return el ? computePosition(el) : null;
  }, [barAnchorId, selectedCount]);

  // ESC to clear selection — skip if a modal/dialog is open
  useEffect(() => {
    if (selectedCount === 0) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"], [data-state="open"]')) return;
      clearSelection();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedCount, clearSelection]);

  // Selection is a transient list mode. Clicking anywhere except another
  // session row or the action bar should return the workspace to its normal state.
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
      contentRef={contentRef}
    />
  );
}
