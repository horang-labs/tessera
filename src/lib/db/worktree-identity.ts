import { randomUUID } from 'node:crypto';

export function generatePublicWorktreeId(): string {
  return `wt_${randomUUID().replaceAll('-', '')}`;
}

/** Temporary compatibility policy for parents that have not stored a path yet. */
export const LEGACY_WORKTREE_PATH_FROM_CHILD_SQL = `(
  SELECT s.work_dir
  FROM sessions s
  WHERE s.task_id = tasks.id
    AND s.deleted = 0
    AND s.work_dir IS NOT NULL
    AND TRIM(s.work_dir) <> ''
  ORDER BY s.created_at ASC, s.id ASC
  LIMIT 1
)`;

/** Parent-owned checkout path, with a temporary fallback for incomplete migrations. */
export const PARENT_FIRST_WORKTREE_PATH_SQL = `CASE
  WHEN tasks.worktree_path IS NOT NULL AND TRIM(tasks.worktree_path) <> ''
    THEN tasks.worktree_path
  ELSE ${LEGACY_WORKTREE_PATH_FROM_CHILD_SQL}
END`;

export function resolveEffectiveWorktreeCheckout(checkout: {
  worktree_path: string | null;
  worktree_branch: string | null;
} | undefined): { path: string | undefined; branch: string | undefined } {
  return {
    path: checkout?.worktree_path && checkout.worktree_path.trim() !== ''
      ? checkout.worktree_path
      : undefined,
    branch: checkout?.worktree_branch && checkout.worktree_branch.trim() !== ''
      ? checkout.worktree_branch
      : undefined,
  };
}
