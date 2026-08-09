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
): CanonicalWorktree | undefined {
  if (!isGitCheckoutPath(filesystemPath)) return undefined;
  const identity = canonicalizeWorktreePath(filesystemPath);
  if (!identity) return undefined;
  const db = getDb();
  const existing = db.prepare(`
    SELECT * FROM worktrees WHERE canonical_path_key = ?
  `).get(identity.canonicalPathKey) as WorktreeRow | undefined;
  if (existing) return mapWorktree(existing);

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

function mapWorktree(row: WorktreeRow): CanonicalWorktree {
  return {
    id: row.id,
    filesystemPath: row.filesystem_path,
    currentBranch: row.filesystem_path
      ? readWorktreeCurrentBranch(row.filesystem_path)
      : null,
  };
}
