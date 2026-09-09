import { GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { DiffStatsBadge } from '@/components/chat/diff-stats-badge';
import { cn } from '@/lib/utils';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { getProjectColor } from '@/lib/constants/project-strip';

export function ProjectWorktreeRow({ active, branch, name, displayPath, diffStats, onSelect, trailingControl, headerControl }: {
  active: boolean;
  branch: string | null;
  name: string;
  displayPath: string;
  diffStats?: WorktreeDiffStats | null;
  onSelect: () => void;
  /** Independent actions must be siblings of the worktree-open button. */
  trailingControl?: ReactNode;
  headerControl?: ReactNode;
}) {
  const branchLabel = branch ?? 'unknown';

  return (
    <div
      className={cn(
        'mt-1 w-full min-w-0 rounded-md transition-colors',
        active
          ? 'text-(--text-primary)'
          : 'text-(--text-secondary)',
      )}
      data-testid="project-worktree-row"
      data-variant="detailed"
    >
      <div className="flex min-w-0 items-center pr-2">
      <button
        {...telemetryClickAttributes('worktree.select', 'worktree')}
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        aria-label={`${name}, ${displayPath}, branch ${branchLabel}`}
        title={displayPath}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-(--sidebar-hover)/50 focus-visible:ring-1 focus-visible:ring-(--accent)"
      >
        <span
          className="mr-0.5 flex h-4 w-4 shrink-0 select-none items-center justify-center rounded text-[0.5rem] font-bold text-white"
          style={{ backgroundColor: getProjectColor(name) }}
          aria-hidden="true"
        >
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 truncate text-[0.625rem] font-semibold uppercase tracking-widest text-(--text-muted)">{name}</span>
        <span className="ml-1 inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 font-mono text-[11px] font-medium text-(--sidebar-text-active)">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-(--accent)" />
          <span className="truncate">{branchLabel}</span>
        </span>
      </button>
      {headerControl}
      </div>
      <CompactProjectWorktreeRow
        testId="project-worktree-path-row"
        active={active}
        branch={branch}
        displayPath={displayPath}
        diffStats={diffStats}
        onSelect={onSelect}
        trailingControl={trailingControl}
      />
    </div>
  );
}

export function CompactProjectWorktreeRow({ active, branch, displayPath, diffStats, onSelect, trailingControl, testId = 'project-worktree-row' }: {
  active: boolean;
  branch: string | null;
  displayPath: string;
  diffStats?: WorktreeDiffStats | null;
  onSelect: () => void;
  trailingControl?: ReactNode;
  testId?: string;
}) {
  const branchLabel = branch ?? 'unknown';

  return (
    <div
      className={cn(
        '-mt-1 -mb-1 flex w-full min-w-0 items-center rounded-md transition-colors',
        active
          ? 'text-(--text-secondary)'
          : 'text-(--text-muted)',
      )}
      data-testid={testId}
      data-variant="compact"
    >
      <button
        {...telemetryClickAttributes('worktree.select', 'worktree')}
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        aria-label={`${displayPath}, branch ${branchLabel}`}
        title={displayPath}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-(--sidebar-hover)/50 hover:text-(--text-secondary) focus-visible:ring-1 focus-visible:ring-(--accent)"
      >
        <span className="min-w-0 max-w-[12rem] truncate font-mono text-[10px]">{displayPath}</span>
      </button>
      <div className="ml-auto flex shrink-0 items-center justify-end gap-1 pr-2 has-[button]:pr-0.5">
        <DiffStatsBadge stats={diffStats} />
        {trailingControl}
      </div>
    </div>
  );
}
