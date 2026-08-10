import {
  canonicalizeWorktreePath,
  generatePublicWorktreeId,
  isGitCheckoutPath,
  readWorktreeCurrentBranch,
} from './worktree-identity';
import { getDb } from './database';

interface WorktreeRow {
  id: string;
  filesystem_path: string | null;
  canonical_path_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalWorktree {
  id: string;
  filesystemPath: string | null;
  currentBranch: string | null;
}

export interface VisibleProjectWorktreeView {
  id: string;
  displayName: string;
}

export function createPendingWorktree(id = generatePublicWorktreeId()): string {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT OR IGNORE INTO worktrees (
      id, filesystem_path, canonical_path_key, created_at, updated_at
    ) VALUES (?, NULL, NULL, ?, ?)
  `).run(id, now, now);
  return id;
}

export function resolveCanonicalWorktree(
  filesystemPath: string,
  preferredId?: string,
  options: { equivalentFilesystemPaths?: readonly string[] } = {},
): CanonicalWorktree | undefined {
  if (!isGitCheckoutPath(filesystemPath)) return undefined;
  const identity = canonicalizeWorktreePath(filesystemPath);
  if (!identity) return undefined;
  const db = getDb();
  const candidateKeys = new Set([identity.canonicalPathKey]);
  for (const equivalentPath of options.equivalentFilesystemPaths ?? []) {
    const direct = canonicalizeWorktreePath(equivalentPath);
    const translated = canonicalizeWorktreePath(equivalentPath, identity.filesystemPath);
    if (direct) candidateKeys.add(direct.canonicalPathKey);
    if (translated) candidateKeys.add(translated.canonicalPathKey);
  }
  const placeholders = [...candidateKeys].map(() => '?').join(', ');
  const existingRows = db.prepare(`
    SELECT * FROM worktrees WHERE canonical_path_key IN (${placeholders})
    ORDER BY created_at, id
  `).all(...candidateKeys) as WorktreeRow[];
  const taskOwners = existingRows.filter((row) => Boolean(db.prepare(`
    SELECT 1 FROM tasks WHERE public_worktree_id = ? LIMIT 1
  `).get(row.id)));
  if (taskOwners.length > 1) {
    throw new Error('Equivalent Worktree paths each own a Worktree Task');
  }
  const existing = taskOwners[0]
    ?? existingRows.find((row) => row.id === preferredId)
    ?? existingRows[0];
  if (existing) {
    const duplicates = existingRows.filter((row) => row.id !== existing.id);
    const needsPathUpdate = existing.filesystem_path !== identity.filesystemPath
      || existing.canonical_path_key !== identity.canonicalPathKey;
    if (duplicates.length > 0 || needsPathUpdate) {
      db.transaction(() => {
        for (const duplicate of duplicates) {
          db.prepare(`
            UPDATE projects SET project_worktree_id = ? WHERE project_worktree_id = ?
          `).run(existing.id, duplicate.id);
          db.prepare(`
            UPDATE sessions SET worktree_id = ? WHERE worktree_id = ?
          `).run(existing.id, duplicate.id);
          db.prepare('DELETE FROM worktrees WHERE id = ?').run(duplicate.id);
          db.prepare(`
            INSERT INTO worktree_identity_reconciliation_authorizations (
              old_worktree_id, new_worktree_id
            ) VALUES (?, ?)
          `).run(duplicate.id, existing.id);
          db.prepare(`
            UPDATE tasks SET creation_scope_worktree_id = ?
            WHERE creation_scope_worktree_id = ?
          `).run(existing.id, duplicate.id);
          db.prepare(`
            DELETE FROM worktree_identity_reconciliation_authorizations
            WHERE old_worktree_id = ? AND new_worktree_id = ?
          `).run(duplicate.id, existing.id);
        }
        if (!needsPathUpdate) return;
        db.prepare(`
          UPDATE worktrees
          SET filesystem_path = ?, canonical_path_key = ?, updated_at = ?
          WHERE id = ?
        `).run(
          identity.filesystemPath,
          identity.canonicalPathKey,
          new Date().toISOString(),
          existing.id,
        );
      })();
    }
    return getWorktree(existing.id);
  }

  const id = preferredId ?? generatePublicWorktreeId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (
      id, filesystem_path, canonical_path_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      filesystem_path = excluded.filesystem_path,
      canonical_path_key = excluded.canonical_path_key,
      updated_at = excluded.updated_at
  `).run(id, identity.filesystemPath, identity.canonicalPathKey, now, now);
  return getWorktree(id);
}

export function getWorktree(id: string): CanonicalWorktree | undefined {
  const row = getDb().prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
    | WorktreeRow
    | undefined;
  return row ? mapWorktree(row) : undefined;
}

export function getVisibleProjectWorktreeViews(worktreeId: string): VisibleProjectWorktreeView[] {
  const rows = getDb().prepare(`
    SELECT id, display_name
    FROM projects
    WHERE project_worktree_id = ? AND visible = 1
    ORDER BY sort_order, display_name
  `).all(worktreeId) as Array<{ id: string; display_name: string }>;
  return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
}

export function getSessionIdsForWorktree(worktreeId: string): string[] {
  const rows = getDb().prepare(`
    SELECT s.id
    FROM sessions s
    WHERE s.deleted = 0
      AND s.worktree_id = ?
    ORDER BY s.id
  `).all(worktreeId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function getTaskIdsForWorktree(worktreeId: string): string[] {
  const rows = getDb().prepare(`
    SELECT id
    FROM tasks
    WHERE public_worktree_id = ?
    ORDER BY created_at, id
  `).all(worktreeId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Record an explicit physical deletion without removing canonical history. */
export function markWorktreeDeleted(worktreeId: string, deletedAt: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET worktree_deleted_at = ?, updated_at = ?
      WHERE public_worktree_id = ?
    `).run(deletedAt, deletedAt, worktreeId);
    db.prepare(`
      UPDATE sessions
      SET worktree_deleted_at = ?, updated_at = ?
      WHERE deleted = 0 AND worktree_id = ?
    `).run(deletedAt, deletedAt, worktreeId);
  })();
}

function mapWorktree(row: WorktreeRow): CanonicalWorktree {
  return {
    id: row.id,
    filesystemPath: row.filesystem_path,
    currentBranch: row.filesystem_path
      ? readWorktreeCurrentBranch(row.filesystem_path)
      : null,
  };
}
