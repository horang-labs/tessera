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
