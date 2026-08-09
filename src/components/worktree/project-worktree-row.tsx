import { GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ProjectWorktreeRow({ active, branch, label, onSelect }: {
  active: boolean;
  branch: string | null;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'mb-2 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
        active
          ? 'bg-(--sidebar-hover) text-(--text-primary)'
          : 'text-(--text-secondary) hover:bg-(--sidebar-hover)',
      )}
      data-testid="project-worktree-row"
    >
      <GitBranch className="h-4 w-4 shrink-0 text-(--accent)" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
      <span className="max-w-[45%] truncate font-mono text-[11px] text-(--text-muted)">
        {branch ?? 'unknown'}
      </span>
    </button>
  );
}
