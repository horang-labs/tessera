import { FolderGit2, GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { DiffStatsBadge } from '@/components/chat/diff-stats-badge';
import { cn } from '@/lib/utils';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

export function ProjectWorktreeRow({ active, branch, name, displayPath, diffStats, onSelect, trailingControl }: {
  active: boolean;
  branch: string | null;
  name: string;
  displayPath: string;
  diffStats?: WorktreeDiffStats | null;
  onSelect: () => void;
  /** Independent actions must be siblings of the worktree-open button. */
  trailingControl?: ReactNode;
}) {
  const branchLabel = branch ?? 'unknown';

  return (
    <div
      className={cn(
        'mb-2 flex w-full min-w-0 items-center rounded-xl border border-(--divider) bg-(--input-bg) transition-colors',
        active
          ? 'border-(--accent)/35 bg-(--sidebar-hover) text-(--text-primary)'
          : 'text-(--text-secondary) hover:border-(--accent)/25 hover:bg-(--sidebar-hover)',
      )}
      data-testid="project-worktree-row"
      data-variant="detailed"
    >
      <button
        {...telemetryClickAttributes('worktree.select', 'worktree')}
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        aria-label={`${name}, ${displayPath}, branch ${branchLabel}`}
        title={displayPath}
        className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2 text-left outline-none"
      >
        <FolderGit2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--accent)" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-semibold text-(--text-primary)">{name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-(--accent)/35 bg-(--accent)/12 px-2 py-0.5 text-[10px] font-medium text-(--sidebar-text-active)">
              <GitBranch className="h-3 w-3 shrink-0 text-(--accent)" />
              <span>{branchLabel}</span>
            </span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-(--text-muted)">{displayPath}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center justify-end gap-1 pr-2.5">
        <DiffStatsBadge stats={diffStats} />
        {trailingControl}
      </div>
    </div>
  );
}

export function CompactProjectWorktreeRow({ active, branch, displayPath, diffStats, onSelect, trailingControl }: {
  active: boolean;
  branch: string | null;
  displayPath: string;
  diffStats?: WorktreeDiffStats | null;
  onSelect: () => void;
  trailingControl?: ReactNode;
}) {
  const branchLabel = branch ?? 'unknown';

  return (
    <div
      className={cn(
        'mb-1 flex w-full min-w-0 items-center rounded-lg border border-(--divider) bg-(--input-bg) transition-colors',
        active
          ? 'border-(--accent)/35 bg-(--sidebar-hover) text-(--text-primary)'
          : 'text-(--text-muted) hover:border-(--accent)/25 hover:bg-(--sidebar-hover) hover:text-(--text-secondary)',
      )}
      data-testid="project-worktree-row"
      data-variant="compact"
    >
      <button
        {...telemetryClickAttributes('worktree.select', 'worktree')}
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        aria-label={`${displayPath}, branch ${branchLabel}`}
        title={displayPath}
        className="flex min-w-0 items-center gap-2 px-2 py-1 text-left outline-none"
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-(--accent)" />
        <span className="max-w-[12rem] truncate font-mono text-[10px]">{displayPath}</span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-(--accent)/35 bg-(--accent)/12 px-2 py-0.5 font-mono text-[10px] font-medium text-(--sidebar-text-active)">
          <GitBranch className="h-3 w-3 shrink-0 text-(--accent)" />
          <span>{branchLabel}</span>
        </span>
      </button>
      <div className="ml-auto flex shrink-0 items-center justify-end gap-1 pr-2">
        <DiffStatsBadge stats={diffStats} />
        {trailingControl}
      </div>
    </div>
  );
}
