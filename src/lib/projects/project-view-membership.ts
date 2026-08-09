/** The only two membership sources accepted by Project View queries. */
export type ProjectViewMembership =
  | {
      kind: 'canonical-worktree';
      worktreeId: string;
      currentBranch: string | null;
    }
  | {
      /** Non-Git Projects have no canonical Worktree identity. */
      kind: 'non-git-project';
      projectId: string;
    };

interface MembershipDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

/**
 * Give every recoverable Git record canonical Project View membership while
 * leaving branch scope null for pre-scope records. Safe to repeat at startup.
 */
export function backfillCanonicalProjectViewMembership(
  db: MembershipDatabase,
  projectId?: string,
): void {
  const projectFilter = projectId ? 'AND t.project_id = ?' : '';
  db.prepare(`
    UPDATE sessions
    SET worktree_id = (
      SELECT t.public_worktree_id FROM tasks t WHERE t.id = sessions.task_id
    )
    WHERE worktree_id IS NULL
      AND task_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = sessions.task_id ${projectFilter}
      )
  `).run(...(projectId ? [projectId] : []));

  const standaloneFilter = projectId ? 'AND p.id = ?' : '';
  db.prepare(`
    UPDATE sessions
    SET worktree_id = (
      SELECT p.project_worktree_id FROM projects p WHERE p.id = sessions.project_id
    )
    WHERE worktree_id IS NULL
      AND task_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = sessions.project_id
          AND p.project_worktree_id IS NOT NULL
          ${standaloneFilter}
      )
  `).run(...(projectId ? [projectId] : []));

  const taskFilter = projectId ? 'AND p.id = ?' : '';
  db.prepare(`
    UPDATE tasks
    SET creation_scope_worktree_id = (
      SELECT p.project_worktree_id FROM projects p WHERE p.id = tasks.project_id
    )
    WHERE creation_scope_worktree_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = tasks.project_id
          AND p.project_worktree_id IS NOT NULL
          ${taskFilter}
      )
  `).run(...(projectId ? [projectId] : []));
}
