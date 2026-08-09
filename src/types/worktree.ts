export interface ProjectWorktreeSummary {
  id: string;
  path: string;
  displayPath: string;
  currentBranch: string | null;
}

export type WorkspaceTarget =
  | { kind: 'session'; id: string }
  | { kind: 'worktree'; id: string };

export function workspaceTargetKey(target: WorkspaceTarget): string {
  return `${target.kind}:${target.id}`;
}

export function workspaceTargetApiPath(target: WorkspaceTarget): string {
  const collection = target.kind === 'session' ? 'sessions' : 'worktrees';
  return `/api/${collection}/${encodeURIComponent(target.id)}`;
}
