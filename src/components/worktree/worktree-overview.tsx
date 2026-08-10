import { GitBranch, GitFork, MessageSquarePlus } from 'lucide-react';

export function WorktreeOverview({ branch, displayPath, label, onNewSession, onNewWorktree }: {
  branch: string | null;
  displayPath: string;
  label?: string;
  onNewSession?: () => void;
  onNewWorktree?: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-(--chat-bg) p-8" data-testid="worktree-overview">
      <div className="w-full max-w-2xl rounded-xl border border-(--divider) bg-(--sidebar-bg) p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-(--accent)/10 text-(--accent)">
            <GitBranch className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-(--text-primary)">{label ?? 'Project Worktree'}</h2>
            <p className="text-xs text-(--text-muted)">Current checkout</p>
          </div>
        </div>
        <dl className="mt-6 grid gap-4 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">Current branch</dt>
            <dd className="mt-1 font-mono text-(--text-primary)">{branch ?? 'unknown'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">Path</dt>
            <dd className="mt-1 break-all font-mono text-(--text-primary)">{displayPath}</dd>
          </div>
        </dl>
        {(onNewSession || onNewWorktree) && (
          <div className="mt-6 flex flex-wrap gap-2">
            {onNewSession && (
              <button type="button" onClick={onNewSession} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-(--accent) px-3 py-2 text-sm font-medium text-white">
                <MessageSquarePlus className="h-4 w-4" />
                New Session
              </button>
            )}
            {onNewWorktree && (
              <button type="button" onClick={onNewWorktree} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-(--input-border) px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--sidebar-hover)">
                <GitFork className="h-4 w-4" />
                New Worktree
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
