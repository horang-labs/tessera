import {
  canonicalizeWorktreePath,
  generatePublicWorktreeId,
  hasHostFilesystemPathStyle,
  isGitCheckoutPath,
  type CanonicalWorktreePath,
} from './worktree-identity';
import { getDb } from './database';
import { CANONICAL_WORKTREE_BOOTSTRAP_META_KEY } from './schema';
import { resolveAgentReportedPath } from '@/lib/filesystem/path-environment';
import { backfillCanonicalProjectViewMembership } from '@/lib/projects/project-view-membership';
import type { AgentEnvironment } from '@/lib/settings/types';

export type WorktreeBootstrapPathResolver = (
  reportedPath: string,
  environment: AgentEnvironment,
) => Promise<string>;

export interface CanonicalWorktreeBootstrapResult {
  status: 'not-required' | 'completed';
  registeredTasks: number;
  registeredProjects: number;
  registeredSessions: number;
  repairedWorktrees: number;
  unresolvedPaths: number;
}

interface TaskPathEvidence {
  public_worktree_id: string;
  worktree_path: string;
}

interface ProjectPathEvidence {
  id: string;
  decoded_path: string;
}

interface SessionPathEvidence {
  id: string;
  work_dir: string;
}

interface RegisteredWorktreeRow {
  id: string;
  canonical_path_key: string;
}

interface HostIncompatibleWorktree {
  id: string;
  filesystem_path: string;
  canonical_path_key: string | null;
}

const EMPTY_RESULT: CanonicalWorktreeBootstrapResult = {
  status: 'not-required',
  registeredTasks: 0,
  registeredProjects: 0,
  registeredSessions: 0,
  repairedWorktrees: 0,
  unresolvedPaths: 0,
};

/**
 * Populate only the new v38 identity fields from clean legacy path evidence.
 *
 * The relationship backfill is version-gated. Registered paths also cross a
 * topology boundary when a WSL-native database is opened by packaged Windows,
 * so host-incompatible Worktree locations are re-routed on startup even after
 * the v38 marker is complete.
 */
export async function bootstrapCanonicalWorktreeRegistry(
  environment: AgentEnvironment,
  resolveAgentPath: WorktreeBootstrapPathResolver = resolveAgentReportedPath,
): Promise<CanonicalWorktreeBootstrapResult> {
  const db = getDb();
  const marker = db.prepare('SELECT value FROM _meta WHERE key = ?')
    .get(CANONICAL_WORKTREE_BOOTSTRAP_META_KEY) as { value: string } | undefined;
  const registryPending = marker?.value === 'pending';
  const hostIncompatibleWorktrees = (db.prepare(`
    SELECT id, filesystem_path, canonical_path_key
    FROM worktrees
    WHERE filesystem_path IS NOT NULL
      AND TRIM(filesystem_path) <> ''
    ORDER BY created_at, id
  `).all() as HostIncompatibleWorktree[]).filter(
    (row) => !hasHostFilesystemPathStyle(row.filesystem_path),
  );
  if (!registryPending && hostIncompatibleWorktrees.length === 0) return { ...EMPTY_RESULT };

  const taskEvidence = registryPending ? db.prepare(`
    SELECT t.public_worktree_id, t.worktree_path
    FROM tasks t
    JOIN worktrees w ON w.id = t.public_worktree_id
    WHERE w.filesystem_path IS NULL
      AND w.canonical_path_key IS NULL
      AND t.worktree_path IS NOT NULL
      AND TRIM(t.worktree_path) <> ''
    ORDER BY t.created_at, t.id
  `).all() as TaskPathEvidence[] : [];
  const projectEvidence = registryPending ? db.prepare(`
    SELECT id, decoded_path
    FROM projects
    WHERE project_worktree_id IS NULL
      AND TRIM(decoded_path) <> ''
    ORDER BY registered_at, id
  `).all() as ProjectPathEvidence[] : [];
  const sessionEvidence = registryPending ? db.prepare(`
    SELECT id, work_dir
    FROM sessions
    WHERE worktree_id IS NULL
      AND task_id IS NULL
      AND work_dir IS NOT NULL
      AND TRIM(work_dir) <> ''
    ORDER BY created_at, id
  `).all() as SessionPathEvidence[] : [];

  const distinctPaths = new Set<string>([
    ...taskEvidence.map((row) => row.worktree_path),
    ...projectEvidence.map((row) => row.decoded_path),
    ...sessionEvidence.map((row) => row.work_dir),
    ...hostIncompatibleWorktrees.map((row) => row.filesystem_path),
  ]);
  const identityByReportedPath = new Map<string, CanonicalWorktreePath | null>();
  await Promise.all([...distinctPaths].map(async (reportedPath) => {
    const routedPath = await resolveAgentPath(reportedPath, environment);
    if (!hasHostFilesystemPathStyle(routedPath)) {
      throw new Error(
        `Agent path routing did not produce a host filesystem path during Worktree bootstrap (${environment})`,
      );
    }
    if (!isGitCheckoutPath(routedPath)) {
      identityByReportedPath.set(reportedPath, null);
      return;
    }
    identityByReportedPath.set(reportedPath, canonicalizeWorktreePath(routedPath));
  }));

  let registeredTasks = 0;
  let registeredProjects = 0;
  let registeredSessions = 0;
  let repairedWorktrees = 0;
  let unresolvedPaths = 0;

  // Path routing is asynchronous. Another startup caller may have completed
  // the same migration while this caller was resolving evidence, so claim the
  // pending state again immediately before the synchronous transaction.
  const currentMarker = db.prepare('SELECT value FROM _meta WHERE key = ?')
    .get(CANONICAL_WORKTREE_BOOTSTRAP_META_KEY) as { value: string } | undefined;
  if (registryPending && currentMarker?.value !== 'pending') return { ...EMPTY_RESULT };

  db.transaction(() => {
    const registeredRows = db.prepare(`
      SELECT id, canonical_path_key
      FROM worktrees
      WHERE canonical_path_key IS NOT NULL
    `).all() as RegisteredWorktreeRow[];
    const worktreeIdByCanonicalKey = new Map(
      registeredRows.map((row) => [row.canonical_path_key, row.id]),
    );
    const now = new Date().toISOString();

    for (const evidence of taskEvidence) {
      const identity = identityByReportedPath.get(evidence.worktree_path);
      if (!identity) {
        unresolvedPaths += 1;
        continue;
      }
      const existingId = worktreeIdByCanonicalKey.get(identity.canonicalPathKey);
      if (existingId && existingId !== evidence.public_worktree_id) {
        // A clean bootstrap never rewrites or merges an existing identity.
        unresolvedPaths += 1;
        continue;
      }
      const { changes } = db.prepare(`
        UPDATE worktrees
        SET filesystem_path = ?, canonical_path_key = ?, updated_at = ?
        WHERE id = ?
          AND filesystem_path IS NULL
          AND canonical_path_key IS NULL
      `).run(
        identity.filesystemPath,
        identity.canonicalPathKey,
        now,
        evidence.public_worktree_id,
      );
      if (changes > 0) {
        registeredTasks += 1;
        worktreeIdByCanonicalKey.set(identity.canonicalPathKey, evidence.public_worktree_id);
      }
    }

    const findOrInsertWorktree = (identity: CanonicalWorktreePath): string => {
      const existingId = worktreeIdByCanonicalKey.get(identity.canonicalPathKey);
      if (existingId) return existingId;
      const worktreeId = generatePublicWorktreeId();
      db.prepare(`
        INSERT INTO worktrees (
          id, filesystem_path, canonical_path_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        worktreeId,
        identity.filesystemPath,
        identity.canonicalPathKey,
        now,
        now,
      );
      worktreeIdByCanonicalKey.set(identity.canonicalPathKey, worktreeId);
      return worktreeId;
    };

    for (const evidence of projectEvidence) {
      const identity = identityByReportedPath.get(evidence.decoded_path);
      if (!identity) {
        unresolvedPaths += 1;
        continue;
      }
      const worktreeId = findOrInsertWorktree(identity);
      registeredProjects += db.prepare(`
        UPDATE projects SET project_worktree_id = ?
        WHERE id = ? AND project_worktree_id IS NULL
      `).run(worktreeId, evidence.id).changes;
    }

    for (const evidence of sessionEvidence) {
      const identity = identityByReportedPath.get(evidence.work_dir);
      if (!identity) {
        unresolvedPaths += 1;
        continue;
      }
      const worktreeId = findOrInsertWorktree(identity);
      registeredSessions += db.prepare(`
        UPDATE sessions SET worktree_id = ?
        WHERE id = ? AND worktree_id IS NULL
      `).run(worktreeId, evidence.id).changes;
    }

    for (const evidence of hostIncompatibleWorktrees) {
      const identity = identityByReportedPath.get(evidence.filesystem_path);
      if (!identity) {
        unresolvedPaths += 1;
        continue;
      }
      const existingId = worktreeIdByCanonicalKey.get(identity.canonicalPathKey);
      if (existingId && existingId !== evidence.id) {
        unresolvedPaths += 1;
        continue;
      }
      const { changes } = db.prepare(`
        UPDATE worktrees
        SET filesystem_path = ?, canonical_path_key = ?, updated_at = ?
        WHERE id = ? AND filesystem_path = ?
      `).run(
        identity.filesystemPath,
        identity.canonicalPathKey,
        now,
        evidence.id,
        evidence.filesystem_path,
      );
      if (changes > 0) {
        repairedWorktrees += 1;
        if (
          evidence.canonical_path_key
          && worktreeIdByCanonicalKey.get(evidence.canonical_path_key) === evidence.id
        ) {
          worktreeIdByCanonicalKey.delete(evidence.canonical_path_key);
        }
        worktreeIdByCanonicalKey.set(identity.canonicalPathKey, evidence.id);
      }
    }

    backfillCanonicalProjectViewMembership(db);
    if (registryPending) {
      db.prepare(`
        UPDATE _meta SET value = 'complete' WHERE key = ? AND value = 'pending'
      `).run(CANONICAL_WORKTREE_BOOTSTRAP_META_KEY);
    }
  })();

  return {
    status: 'completed',
    registeredTasks,
    registeredProjects,
    registeredSessions,
    repairedWorktrees,
    unresolvedPaths,
  };
}
