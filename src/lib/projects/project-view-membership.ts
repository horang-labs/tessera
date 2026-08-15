/** The only two membership sources accepted by Project View queries. */
export type ProjectViewMembership =
  | {
      kind: 'canonical-worktree';
      worktreeId: string;
      currentBranch: string | null;
      /** Narrow legacy lookup for only the selected Project's exact root. */
      projectRootFallback?: {
        projectId: string;
        workDir: string;
      };
    }
  | {
      /** Non-Git Projects have no canonical Worktree identity. */
      kind: 'non-git-project';
      projectId: string;
    };

interface MembershipDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

function backfillStandaloneSessionsFromCheckoutPath(
  db: MembershipDatabase,
  projectId?: string,
): void {
  const projectFilter = projectId ? 'AND project_id = ?' : '';
  db.prepare(`
    UPDATE sessions
    SET worktree_id = (
      SELECT w.id
      FROM worktrees w
      WHERE w.filesystem_path = sessions.work_dir
         OR w.canonical_path_key = sessions.work_dir
      ORDER BY w.created_at, w.id
      LIMIT 1
    )
    WHERE worktree_id IS NULL
      AND task_id IS NULL
      AND work_dir IS NOT NULL
      AND TRIM(work_dir) <> ''
      ${projectFilter}
      AND EXISTS (
        SELECT 1 FROM worktrees w
        WHERE w.filesystem_path = sessions.work_dir
           OR w.canonical_path_key = sessions.work_dir
      )
  `).run(...(projectId ? [projectId] : []));
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

  // Same-spelling rows are safe to repair synchronously. Cross-environment
  // paths remain null until authenticated canonical routing can translate the
  // CLI-reported path in the user's configured agent environment.
  backfillStandaloneSessionsFromCheckoutPath(db, projectId);

  const standaloneFilter = projectId ? 'AND p.id = ?' : '';
  db.prepare(`
    UPDATE sessions
    SET worktree_id = (
      SELECT p.project_worktree_id FROM projects p WHERE p.id = sessions.project_id
    )
    WHERE worktree_id IS NULL
      AND task_id IS NULL
      AND (work_dir IS NULL OR TRIM(work_dir) = '')
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
