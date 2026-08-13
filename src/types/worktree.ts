export interface ProjectWorktreeSummary {
  id: string;
  path: string;
  displayPath: string;
  currentBranch: string | null;
  /** Cached working-tree change totals for the canonical checkout. */
  diffStats?: import('./worktree-diff-stats').WorktreeDiffStats | null;
}

export type WorkspaceTarget =
  | { kind: 'session'; id: string }
  | { kind: 'worktree'; id: string };

/** Select the most specific Git-capable workspace target. */
export function resolveWorkspaceTarget(
  sessionId: string | null | undefined,
  worktreeId: string | null | undefined,
): WorkspaceTarget | null {
  if (sessionId) return { kind: 'session', id: sessionId };
  if (worktreeId) return { kind: 'worktree', id: worktreeId };
  return null;
}

export function workspaceTargetKey(target: WorkspaceTarget): string {
  return `${target.kind}:${target.id}`;
}

export function workspaceTargetApiPath(target: WorkspaceTarget): string {
  const collection = target.kind === 'session' ? 'sessions' : 'worktrees';
  return `/api/${collection}/${encodeURIComponent(target.id)}`;
}
