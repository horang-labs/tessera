export interface ProjectWorktreeSummary {
  id: string;
  path: string;
  displayPath: string;
  currentBranch: string | null;
}

export type WorkspaceTarget =
  | { kind: 'session'; id: string }
  | { kind: 'worktree'; id: string };

/** A live Session owns capabilities; a bare Worktree is the read-only fallback. */
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
