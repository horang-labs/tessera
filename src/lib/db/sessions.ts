/**
 * Session CRUD and query operations backed by SQLite.
 */

import { getDb } from './database';

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  has_custom_title: number; // 0 | 1
  provider: string;
  provider_state: string | null;
  workflow_status?: string | null;
  work_dir: string | null;
  worktree_branch: string | null;
  worktree_managed?: number;
  archived: number; // 0 | 1
  archived_at: string | null;
  worktree_deleted_at: string | null;
  deleted: number; // 0 | 1 — soft-delete flag
  task_id: string | null;
  collection_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SessionQueryResult {
  sessions: SessionRow[];
  totalCount: number;
  nextCursor: string | null;
}

function isUuidLikeSearchQuery(query: string): boolean {
  return /^[0-9a-f]{6,}(?:-[0-9a-f]*)*$/i.test(query);
}

const SESSION_STATUS_GROUP_SQL = `
  CASE
    WHEN s.task_id IS NULL THEN 'chat'
    ELSE COALESCE(t.workflow_status, 'todo')
  END
`;

const SESSION_SELECT_WITH_TASK = `
  SELECT
    s.*,
    t.workflow_status AS workflow_status
  FROM sessions s
  LEFT JOIN tasks t ON t.id = s.task_id
  LEFT JOIN projects p ON p.id = s.project_id
`;

const ACTIVE_SESSION_SCOPE_SQL = `
  s.deleted = 0
  AND (
    (s.task_id IS NULL AND s.archived = 0)
    OR (s.task_id IS NOT NULL AND COALESCE(t.archived, 0) = 0)
  )
`;

export interface ArchivedSessionQueryOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

function escapeLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function archivedChatWhere(
  projectId?: string,
  query?: string,
): { sql: string; params: unknown[] } {
  const conditions = [
    's.archived = 1',
    's.deleted = 0',
    's.task_id IS NULL',
  ];
  const params: unknown[] = [];

  if (projectId) {
    conditions.push('s.project_id = ?');
    params.push(projectId);
  }

  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    const pattern = escapeLikePattern(normalizedQuery);
    conditions.push(`(
      s.title LIKE ? ESCAPE '\\'
      OR s.project_id LIKE ? ESCAPE '\\'
      OR COALESCE(s.work_dir, '') LIKE ? ESCAPE '\\'
      OR COALESCE(s.worktree_branch, '') LIKE ? ESCAPE '\\'
      OR COALESCE(p.display_name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(p.decoded_path, '') LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return { sql: conditions.join(' AND '), params };
}
/**
 * Create a new session record.
 */
export function createSession(
  id: string,
  projectId: string,
  title: string,
  provider: string,
  options: {
    workDir?: string;
    worktreeManaged?: boolean;
    taskId?: string;
    collectionId?: string;
  } = {}
): void {
  const db = getDb();
  const now = new Date().toISOString();
  // Keep newest sessions at the top of the project-local ordering.
  db.prepare(`
    UPDATE sessions SET sort_order = sort_order + 1
    WHERE project_id = ? AND deleted = 0
  `).run(projectId);
  db.prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, work_dir, worktree_managed,
      task_id, collection_id, sort_order, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    projectId,
    title,
    provider,
    options.workDir ?? null,
    options.worktreeManaged ? 1 : 0,
    options.taskId ?? null,
    options.collectionId ?? null,
    now,
    now
  );
}

/**
 * Delete a session record.
 */
export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/**
 * Count how many OTHER sessions share the same work_dir (excludes the given session).
 * Used to decide whether to physically remove a managed worktree on session deletion.
 */
export function countOtherSessionsByWorkDir(workDir: string, excludeSessionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE work_dir = ? AND id != ? AND deleted = 0')
    .get(workDir, excludeSessionId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Count how many non-archived sessions still reference the same work_dir.
 * Used to determine whether a managed worktree can be removed on archive.
 */
export function countNonArchivedSessionsByWorkDir(workDir: string): number {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS cnt
      FROM sessions s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.work_dir = ? AND ${ACTIVE_SESSION_SCOPE_SQL}
    `)
    .get(workDir) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * List non-deleted sessions that still reference a work_dir.
 * Used to clear stale worktree metadata after the physical worktree is removed.
 */
export function getSessionsByWorkDir(workDir: string): Array<Pick<SessionRow, 'id' | 'task_id' | 'worktree_branch'>> {
  return getDb().prepare(`
    SELECT id, task_id, worktree_branch
    FROM sessions
    WHERE work_dir = ? AND deleted = 0
  `).all(workDir) as Array<Pick<SessionRow, 'id' | 'task_id' | 'worktree_branch'>>;
}

/**
 * Sessions that the bare-session PR poller should sweep: have a working
 * directory, are not bound to a task (those flow through task-pr-sync),
 * and aren't soft-deleted or archived.
 */
export function getSessionsEligibleForBareSessionPrSync(): Array<Pick<SessionRow, 'id' | 'work_dir'>> {
  return getDb().prepare(`
    SELECT id, work_dir
    FROM sessions
    WHERE deleted = 0
      AND archived = 0
      AND task_id IS NULL
      AND work_dir IS NOT NULL
  `).all() as Array<Pick<SessionRow, 'id' | 'work_dir'>>;
}

/**
 * Clear worktree metadata for all sessions that reference the given work_dir.
 */
export function clearWorktreeMetadataByWorkDir(workDir: string): void {
  getDb().prepare(`
    UPDATE sessions
    SET work_dir = NULL, worktree_branch = NULL, worktree_managed = 0, updated_at = ?
    WHERE work_dir = ?
  `).run(new Date().toISOString(), workDir);
}

/**
 * Soft-delete a session (set deleted flag instead of removing the row).
 */
export function softDeleteSession(id: string): void {
  getDb().prepare('UPDATE sessions SET deleted = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

/**
 * Update session fields. Only provided fields are updated.
 */
export function updateSession(
  id: string,
  patch: Partial<Pick<SessionRow, 'title' | 'has_custom_title' | 'work_dir' | 'worktree_branch' | 'worktree_managed' | 'archived' | 'archived_at' | 'worktree_deleted_at' | 'provider_state' | 'project_id' | 'task_id' | 'collection_id'>>,
  options?: { skipTimestamp?: boolean }
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
  if (patch.has_custom_title !== undefined) { sets.push('has_custom_title = ?'); values.push(patch.has_custom_title); }
  if (patch.work_dir !== undefined) { sets.push('work_dir = ?'); values.push(patch.work_dir); }
  if (patch.worktree_branch !== undefined) { sets.push('worktree_branch = ?'); values.push(patch.worktree_branch); }
  if (patch.worktree_managed !== undefined) { sets.push('worktree_managed = ?'); values.push(patch.worktree_managed); }
  if (patch.archived !== undefined) { sets.push('archived = ?'); values.push(patch.archived); }
  if (patch.archived_at !== undefined) { sets.push('archived_at = ?'); values.push(patch.archived_at); }
  if (patch.worktree_deleted_at !== undefined) { sets.push('worktree_deleted_at = ?'); values.push(patch.worktree_deleted_at); }
  if (patch.provider_state !== undefined) { sets.push('provider_state = ?'); values.push(patch.provider_state); }
  if (patch.project_id !== undefined) { sets.push('project_id = ?'); values.push(patch.project_id); }
  if (patch.task_id !== undefined) { sets.push('task_id = ?'); values.push(patch.task_id); }
  if (patch.collection_id !== undefined) { sets.push('collection_id = ?'); values.push(patch.collection_id); }

  if (sets.length === 0) return;

  if (!options?.skipTimestamp) {
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
  }
  values.push(id);

  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Get a single session by ID.
 */
export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare(`
    ${SESSION_SELECT_WITH_TASK}
    WHERE s.id = ?
  `).get(id) as SessionRow | undefined;
}

export function getArchivedChatSessions(
  projectId?: string,
  options: ArchivedSessionQueryOptions = {},
): SessionRow[] {
  const db = getDb();
  const where = archivedChatWhere(projectId, options.query);
  const limitSql = options.limit !== undefined ? 'LIMIT ? OFFSET ?' : '';
  const params = [...where.params];
  if (options.limit !== undefined) {
    params.push(options.limit, options.offset ?? 0);
  }

  return db.prepare(`
    ${SESSION_SELECT_WITH_TASK}
    WHERE ${where.sql}
    ORDER BY COALESCE(s.archived_at, s.updated_at) DESC
    ${limitSql}
  `).all(...params) as SessionRow[];
}

export function countArchivedChatSessions(projectId?: string, query?: string): number {
  const where = archivedChatWhere(projectId, query);
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE ${where.sql}
  `).get(...where.params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function setSessionWorktreeDeletedAt(id: string, deletedAt: string): void {
  updateSession(id, { worktree_deleted_at: deletedAt });
}

/**
 * Get sessions for a project with cursor-based pagination.
 * Cursor is the updated_at timestamp of the last session in the previous page.
 */
export function getSessionsByProject(
  projectId: string,
  options: { limit?: number; cursor?: string } = {}
): SessionQueryResult {
  const db = getDb();
  const limit = options.limit ?? 20;

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL}
  `).get(projectId) as { cnt: number };

  let sessions: SessionRow[];
  if (options.cursor) {
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL} AND s.sort_order > ?
      ORDER BY s.sort_order ASC
      LIMIT ?
    `).all(projectId, parseInt(options.cursor, 10), limit) as SessionRow[];
  } else {
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL}
      ORDER BY s.sort_order ASC
      LIMIT ?
    `).all(projectId, limit) as SessionRow[];
  }

  const nextCursor = sessions.length === limit
    ? String(sessions[sessions.length - 1].sort_order)
    : null;

  return {
    sessions,
    totalCount: countRow.cnt,
    nextCursor,
  };
}

/**
 * Get sessions for a project grouped by sidebar bucket, with per-status limit.
 */
export function getSessionsByProjectGrouped(
  projectId: string,
  options: { limitPerStatus?: number } = {}
): { sessions: SessionRow[]; totalCount: number; countByStatus: Record<string, number> } {
  const db = getDb();
  const limitPerStatus = options.limitPerStatus ?? 20;

  // Get counts per status (exclude archived and soft-deleted)
  const statusCounts = db.prepare(`
    SELECT ${SESSION_STATUS_GROUP_SQL} AS status_group, COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL}
    GROUP BY status_group
  `).all(projectId) as { status_group: string; cnt: number }[];

  const countByStatus: Record<string, number> = {};
  let totalCount = 0;
  for (const row of statusCounts) {
    countByStatus[row.status_group] = row.cnt;
    totalCount += row.cnt;
  }

  // Get top N sessions per status using UNION ALL
  const statuses = statusCounts.map(r => r.status_group);
  if (statuses.length === 0) {
    return { sessions: [], totalCount: 0, countByStatus };
  }

  const unions = statuses.map(() =>
    `SELECT * FROM (
      ${SESSION_SELECT_WITH_TASK}
      WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ?
      ORDER BY s.sort_order ASC
      LIMIT ?
    )`
  ).join(' UNION ALL ');

  const params: unknown[] = [];
  for (const status of statuses) {
    params.push(projectId, status, limitPerStatus);
  }

  const sessions = db.prepare(unions).all(...params) as SessionRow[];

  return { sessions, totalCount, countByStatus };
}

/**
 * Get sessions for a project filtered by sidebar bucket with cursor pagination.
 */
export function getSessionsByStatus(
  projectId: string,
  statusGroup: string,
  options: { limit?: number; cursor?: string } = {}
): { sessions: SessionRow[]; totalCount: number; nextCursor: string | null } {
  const db = getDb();
  const limit = options.limit ?? 20;

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ?
  `).get(projectId, statusGroup) as { cnt: number };

  let sessions: SessionRow[];
  if (options.cursor) {
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ? AND s.sort_order > ?
      ORDER BY s.sort_order ASC
      LIMIT ?
    `).all(projectId, statusGroup, parseInt(options.cursor, 10), limit) as SessionRow[];
  } else {
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ?
      ORDER BY s.sort_order ASC
      LIMIT ?
    `).all(projectId, statusGroup, limit) as SessionRow[];
  }

  const nextCursor = sessions.length === limit
    ? String(sessions[sessions.length - 1].sort_order)
    : null;

  return { sessions, totalCount: countRow.cnt, nextCursor };
}

/**
 * Maps a SessionRow + runtime flags to the API response shape used by both
 * /api/sessions/projects and /api/sessions/projects/:encodedDir.
 */
export function mapSessionRowToApi(
  row: SessionRow,
  activeSessionIds: Set<string>,
  generatingSessionIds: Set<string>,
) {
  const isRunning = activeSessionIds.has(row.id);
  const isGenerating = generatingSessionIds.has(row.id);
  return {
    id: row.id,
    title: row.title,
    hasCustomTitle: !!row.has_custom_title,
    lastModified: row.updated_at,
    createdAt: row.created_at,
    isRunning,
    isGenerating,
    status: isRunning ? 'running' : ('completed' as const),
    projectDir: row.project_id,
    workDir: row.work_dir ?? undefined,
    workflowStatus: row.workflow_status ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
    archived: !!row.archived,
    archivedAt: row.archived_at ?? undefined,
    worktreeDeletedAt: row.worktree_deleted_at ?? undefined,
    provider: row.provider,
    taskId: row.task_id ?? undefined,
    collectionId: row.collection_id ?? undefined,
  };
}

/**
 * Safely extract threadId from a provider_state JSON string.
 * Returns undefined if the value is null, empty, or unparseable.
 */
export function extractThreadId(providerState: string | null): string | undefined {
  if (!providerState) return undefined;
  try {
    return JSON.parse(providerState).threadId;
  } catch {
    return undefined;
  }
}

/**
 * Safely extract the OpenCode ACP session id from provider_state JSON.
 * Returns undefined if the value is null, empty, or unparseable.
 */
export function extractOpenCodeSessionId(providerState: string | null): string | undefined {
  if (!providerState) return undefined;
  try {
    const value = JSON.parse(providerState).opencodeSessionId;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Touch session updated_at (e.g., when a message is received).
 */
export function touchSession(id: string): void {
  getDb().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

/**
 * Reorder sessions within a project.
 * @param projectId - project ID
 * @param orderedIds - session IDs in the desired display order
 */
export function reorderSessions(projectId: string, orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ? AND project_id = ?');
  const runAll = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, projectId));
  });
  runAll();
}

/**
 * Reorder sessions by ID only (no project scoping).
 */
export function reorderSessionsByIds(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id));
  })();
}
