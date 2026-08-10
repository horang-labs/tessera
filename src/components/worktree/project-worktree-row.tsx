import { FolderGit2, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ProjectWorktreeRow({ active, branch, name, displayPath, onSelect }: {
  active: boolean;
  branch: string | null;
  name: string;
  displayPath: string;
  onSelect: () => void;
}) {
  const branchLabel = branch ?? 'unknown';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      aria-label={`${name}, ${displayPath}, branch ${branchLabel}`}
      title={displayPath}
      className={cn(
        'mb-2 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors',
        active
          ? 'bg-(--sidebar-hover) text-(--text-primary)'
          : 'text-(--text-secondary) hover:bg-(--sidebar-hover)',
      )}
      data-testid="project-worktree-row"
      data-variant="detailed"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-(--accent)/10 text-(--accent)">
        <FolderGit2 className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-(--text-primary)">
            {name}
          </span>
          <span className="inline-flex max-w-[48%] shrink-0 items-center gap-1 rounded-full border border-(--divider) bg-(--input-bg) px-1.5 py-0.5 font-mono text-[10px] text-(--text-secondary)">
            <GitBranch className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{branchLabel}</span>
          </span>
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-(--text-muted)">
          {displayPath}
        </span>
      </span>
    </button>
  );
}

export function CompactProjectWorktreeRow({ active, branch, displayPath, onSelect }: {
  active: boolean;
  branch: string | null;
  displayPath: string;
  onSelect: () => void;
}) {
  const branchLabel = branch ?? 'unknown';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      aria-label={`${displayPath}, branch ${branchLabel}`}
      title={displayPath}
      className={cn(
        'mb-1.5 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        active
          ? 'bg-(--sidebar-hover) text-(--text-primary)'
          : 'text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-secondary)',
      )}
      data-testid="project-worktree-row"
      data-variant="compact"
    >
      <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-(--accent)" />
      <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
        {displayPath}
      </span>
      <span className="inline-flex max-w-[42%] shrink-0 items-center gap-1 rounded-full border border-(--divider) bg-(--input-bg) px-1.5 py-0.5 font-mono text-[9px] text-(--text-secondary)">
        <GitBranch className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{branchLabel}</span>
      </span>
    </button>
  );
}
