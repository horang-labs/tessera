import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

function formatShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

function buildTooltip(stats: WorktreeDiffStats): string {
  const parts = [`+${stats.added.toLocaleString()} −${stats.removed.toLocaleString()}`];
  const files: string[] = [];
  if (stats.changedFiles > 0) {
    files.push(`${stats.changedFiles} file${stats.changedFiles === 1 ? '' : 's'} changed`);
  }
  if (stats.newFiles > 0) files.push(`${stats.newFiles} new`);
  if (stats.deletedFiles > 0) files.push(`${stats.deletedFiles} deleted`);
  if (files.length > 0) parts.push(files.join(' · '));
  return parts.join('\n');
}

interface DiffStatsBadgeProps {
  stats: WorktreeDiffStats | null | undefined;
  className?: string;
}

function DiffStatsBadgeImpl({ stats, className }: DiffStatsBadgeProps) {
  if (!stats) return null;
  if (stats.added === 0 && stats.removed === 0) return null;

  return (
    <span
      className={cn(
        'inline-flex cursor-help items-baseline gap-1 text-[0.6875rem] font-medium tabular-nums whitespace-nowrap shrink-0',
        className,
      )}
      title={buildTooltip(stats)}
    >
      <span className="text-(--status-success-text)">+{formatShort(stats.added)}</span>
      <span className="text-(--status-error-text)">−{formatShort(stats.removed)}</span>
    </span>
  );
}

export const DiffStatsBadge = memo(DiffStatsBadgeImpl);
