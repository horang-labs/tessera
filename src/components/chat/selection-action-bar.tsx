'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Archive, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSelectionStore } from '@/stores/selection-store';

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
  const barWidth = 340; // approximate max width
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
  bulkDelete: () => void;
}

function SelectionActionBarContent({
  selectedCount,
  position,
  clearSelection,
  bulkMarkDone,
  bulkArchive,
  bulkDelete,
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
      style={{ top: position.top, left: position.left }}
      className={cn(
        'fixed z-[9998]',
        'flex items-center gap-2 px-4 py-2.5 rounded-xl',
        'bg-(--sidebar-bg) border border-(--divider)',
        'shadow-[0_8px_32px_rgba(0,0,0,0.3),0_2px_8px_rgba(0,0,0,0.2)]',
        'animate-in fade-in duration-150',
      )}
      data-testid="selection-action-bar"
    >
      <span className="text-[13px] font-semibold text-(--text-primary) whitespace-nowrap tabular-nums">
        {selectedCount}
        <span className="text-(--text-muted) font-normal ml-1">selected</span>
      </span>

      <div className="w-px h-5 bg-(--divider) mx-1" />

      <button
        onClick={bulkMarkDone}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium',
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
        onClick={bulkArchive}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium',
          'text-(--text-secondary) hover:bg-(--sidebar-hover)',
          'transition-colors whitespace-nowrap',
        )}
        data-testid="bulk-archive"
      >
        <Archive className="w-3.5 h-3.5" />
        Archive
      </button>

      <button
        onClick={handleDelete}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium',
          'transition-colors whitespace-nowrap',
          confirmDelete
            ? 'bg-(--error) text-white hover:bg-[color-mix(in_srgb,var(--error)_85%,black)]'
            : 'text-(--error) hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]',
        )}
        data-testid="bulk-delete"
      >
        <Trash2 className="w-3.5 h-3.5" />
        {confirmDelete ? 'Confirm' : 'Delete'}
      </button>

      <div className="w-px h-5 bg-(--divider) mx-1" />

      <button
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
  const bulkDelete = useSelectionStore((state) => state.bulkDelete);
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

  if (selectedCount === 0 || typeof document === 'undefined' || !position) return null;

  return (
    <SelectionActionBarContent
      key={`${barAnchorId}:${selectedCount}`}
      selectedCount={selectedCount}
      position={position}
      clearSelection={clearSelection}
      bulkMarkDone={bulkMarkDone}
      bulkArchive={bulkArchive}
      bulkDelete={bulkDelete}
    />
  );
}
