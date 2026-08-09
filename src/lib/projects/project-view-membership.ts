import { canonicalizeWorktreePath } from '@/lib/db/worktree-identity';

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
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

interface LegacyStandaloneSession {
  id: string;
  work_dir: string;
}

interface RegisteredWorktreePath {
  id: string;
  filesystem_path: string | null;
  canonical_path_key: string | null;
}

function backfillStandaloneSessionsFromCheckoutPath(
  db: MembershipDatabase,
  projectId?: string,
): void {
  const projectFilter = projectId ? 'AND project_id = ?' : '';
  const sessions = db.prepare(`
    SELECT id, work_dir
    FROM sessions
    WHERE worktree_id IS NULL
      AND task_id IS NULL
      AND work_dir IS NOT NULL
      AND TRIM(work_dir) <> ''
      ${projectFilter}
  `).all(...(projectId ? [projectId] : [])) as LegacyStandaloneSession[];
  if (sessions.length === 0) return;

  const registered = db.prepare(`
    SELECT id, filesystem_path, canonical_path_key FROM worktrees
  `).all() as RegisteredWorktreePath[];
  const worktreeIdByPathKey = new Map<string, string>();
  for (const worktree of registered) {
    if (worktree.canonical_path_key) {
      worktreeIdByPathKey.set(worktree.canonical_path_key, worktree.id);
    }
    if (worktree.filesystem_path) {
      const identity = canonicalizeWorktreePath(worktree.filesystem_path);
      if (identity) worktreeIdByPathKey.set(identity.canonicalPathKey, worktree.id);
    }
  }

  const update = db.prepare(`
    UPDATE sessions SET worktree_id = ?
    WHERE id = ? AND worktree_id IS NULL
  `);
  for (const session of sessions) {
    const identity = canonicalizeWorktreePath(session.work_dir);
    const worktreeId = identity
      ? worktreeIdByPathKey.get(identity.canonicalPathKey)
      : undefined;
    if (worktreeId) update.run(worktreeId, session.id);
  }
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

  // A taskless legacy Session may have been launched in a linked checkout
  // while retaining the Project from which it was opened. Its checkout path,
  // when it resolves to an already registered Worktree, is stronger identity
  // evidence than that representative Project.
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
