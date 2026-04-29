'use client';

import { memo } from 'react';
import { List, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import type { ViewMode } from '@/stores/board-store';

interface ViewModeToggleProps {
  viewMode: ViewMode;
  onToggle: (mode: ViewMode) => void;
  /** When true, show icons only (no text labels) */
  compact?: boolean;
}

/**
 * ViewModeToggle
 *
 * Segmented control for switching between List and Board views.
 * Icon + label for clarity.
 */
export const ViewModeToggle = memo(function ViewModeToggle({
  viewMode,
  onToggle,
  compact = false,
}: ViewModeToggleProps) {
  const { t } = useI18n();

  return (
    <div
      className="flex items-center shrink-0 gap-0.5 rounded-lg bg-(--sidebar-hover) p-0.5"
      role="group"
      aria-label="View mode"
      data-testid="view-mode-toggle"
    >
      {/* List view button */}
      <ShortcutTooltip id="toggle-view" label={t('task.board.viewList')}>
        <button
          onClick={() => onToggle('list')}
          aria-pressed={viewMode === 'list'}
          aria-label={t('task.board.viewList')}
          data-testid="view-mode-list"
          className={cn(
            'flex items-center gap-1 rounded-md text-xs font-medium transition-all duration-150',
            compact ? 'px-1.5 py-1' : 'px-2.5 py-1',
            viewMode === 'list'
              ? 'text-(--accent) bg-(--sidebar-bg) shadow-sm'
              : 'text-(--text-muted) hover:text-(--sidebar-text)',
          )}
        >
          <List size={14} />
          {!compact && <span>{t('task.board.viewList')}</span>}
        </button>
      </ShortcutTooltip>

      {/* Board view button */}
      <ShortcutTooltip id="toggle-view" label={t('task.board.viewBoard')}>
        <button
          onClick={() => onToggle('board')}
          aria-pressed={viewMode === 'board'}
          aria-label={t('task.board.viewBoard')}
          data-testid="view-mode-board"
          className={cn(
            'flex items-center gap-1 rounded-md text-xs font-medium transition-all duration-150',
            compact ? 'px-1.5 py-1' : 'px-2.5 py-1',
            viewMode === 'board'
              ? 'text-(--accent) bg-(--sidebar-bg) shadow-sm'
              : 'text-(--text-muted) hover:text-(--sidebar-text)',
          )}
        >
          <LayoutGrid size={14} />
          {!compact && <span>{t('task.board.viewBoard')}</span>}
        </button>
      </ShortcutTooltip>
    </div>
  );
});
