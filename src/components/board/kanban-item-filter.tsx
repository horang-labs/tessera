'use client';

import { memo } from 'react';
import { CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

interface KanbanItemFilterProps {
  running: boolean;
  runningCount: number;
  onChange: (running: boolean) => void;
}

export const KanbanItemFilter = memo(function KanbanItemFilter({
  running,
  runningCount,
  onChange,
}: KanbanItemFilterProps) {
  const { t } = useI18n();
  const countLabel = runningCount > 99 ? '99+' : String(runningCount);

  return (
    <div
      className="grid h-7 shrink-0 grid-cols-2 rounded-md border border-(--divider) bg-(--sidebar-bg) p-px"
      role="group"
      aria-label={`${t('common.all')} / ${t('status.running')}`}
      data-testid="kanban-item-filter"
    >
      <button
        type="button"
        {...telemetryClickAttributes('board.running_filter.all', 'workspace_board')}
        onClick={() => onChange(false)}
        aria-pressed={!running}
        className={cn(
          'min-w-[3.25rem] rounded px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/35',
          !running
            ? 'bg-(--sidebar-hover) text-(--sidebar-text-active)'
            : 'text-(--text-muted) hover:text-(--sidebar-text-active)',
        )}
        data-testid="kanban-all-filter"
      >
        {t('common.all')}
      </button>
      <button
        type="button"
        {...telemetryClickAttributes('board.running_filter.running', 'workspace_board')}
        onClick={() => onChange(true)}
        aria-pressed={running}
        className={cn(
          'flex min-w-[5.75rem] items-center justify-center gap-1 rounded px-2',
          'text-[0.6875rem] font-semibold uppercase tracking-[0.08em] transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--success)/35',
          running
            ? 'bg-[color-mix(in_srgb,var(--success)_13%,var(--sidebar-hover))] text-(--sidebar-text-active)'
            : 'text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--success)_7%,transparent)] hover:text-(--sidebar-text-active)',
        )}
        data-testid="kanban-running-filter"
      >
        <CircleDot
          className={cn(
            'h-2.5 w-2.5 shrink-0',
            running || runningCount > 0 ? 'text-(--success)' : 'text-(--text-muted)',
          )}
          aria-hidden="true"
        />
        <span>{t('status.running')}</span>
        <span className="text-[0.625rem] tabular-nums text-(--text-muted)">
          {countLabel}
        </span>
      </button>
    </div>
  );
});
