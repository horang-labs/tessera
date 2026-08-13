'use client';

import { memo } from 'react';
import { Columns3, List } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import type { ViewMode } from '@/stores/board-store';

interface ViewModeToggleProps {
  viewMode: ViewMode;
  onToggle: (mode: ViewMode) => void;
  /** When true, show icons only (no text labels) */
  compact?: boolean;
  labelMode?: 'full' | 'short' | 'icon';
}

/**
 * ViewModeToggle
 *
 * Standard segmented control for switching between List and Kanban Board views.
 */
export const ViewModeToggle = memo(function ViewModeToggle({
  viewMode,
  onToggle,
  compact = false,
  labelMode = 'full',
}: ViewModeToggleProps) {
  const { t } = useI18n();
  const resolvedLabelMode = compact ? 'icon' : labelMode;
  const shouldShowText = resolvedLabelMode !== 'icon';
  const listLabel = resolvedLabelMode === 'short' ? t('task.board.viewListShort') : t('task.board.viewList');
  const boardLabel = resolvedLabelMode === 'short' ? t('task.board.viewBoardShort') : t('task.board.viewBoard');

  return (
    <div
      className="flex h-7 shrink-0 items-center rounded-md border border-[color-mix(in_srgb,var(--accent)_28%,var(--divider))] bg-(--input-bg) p-0.5 shadow-sm shadow-black/10"
      role="group"
      aria-label="View mode"
      data-testid="view-mode-toggle"
    >
      {/* List view button */}
      <ShortcutTooltip id="toggle-view" label={t('task.board.viewList')}>
        <button
          type="button"
          onClick={() => onToggle('list')}
          aria-pressed={viewMode === 'list'}
          aria-label={t('task.board.viewList')}
          data-testid="view-mode-list"
          className={cn(
            'flex h-6 items-center justify-center gap-1 rounded-[0.25rem] text-[0.75rem] font-semibold leading-none transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/35',
            shouldShowText ? 'min-w-[3.625rem] px-2' : 'w-6 px-1',
            viewMode === 'list'
              ? 'bg-(--accent) text-white shadow-sm shadow-black/20'
              : 'text-(--text-secondary) hover:bg-(--sidebar-active) hover:text-(--text-primary)',
          )}
        >
          <List size={14} strokeWidth={2.2} />
          {shouldShowText && <span>{listLabel}</span>}
        </button>
      </ShortcutTooltip>

      {/* Board view button */}
      <ShortcutTooltip id="toggle-view" label={t('task.board.viewBoard')}>
        <button
          type="button"
          onClick={() => onToggle('board')}
          aria-pressed={viewMode === 'board'}
          aria-label={t('task.board.viewBoard')}
          data-testid="view-mode-board"
          className={cn(
            'flex h-6 items-center justify-center gap-1 rounded-[0.25rem] text-[0.75rem] font-semibold leading-none transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/35',
            shouldShowText ? 'min-w-[3.625rem] px-2' : 'w-6 px-1',
            viewMode === 'board'
              ? 'bg-(--accent) text-white shadow-sm shadow-black/20'
              : 'text-(--text-secondary) hover:bg-(--sidebar-active) hover:text-(--text-primary)',
          )}
        >
          <Columns3 size={14} strokeWidth={2.2} />
          {shouldShowText && <span>{boardLabel}</span>}
        </button>
      </ShortcutTooltip>
    </div>
  );
});
