/**
 * Session CRUD and query operations backed by SQLite.
 */

import fs from 'fs';
import { getDb } from './database';
import { deleteTerminalProviderSessionsForTesseraSession } from './terminal-provider-sessions';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import {
  PARENT_FIRST_WORKTREE_PATH_SQL,
  resolveEffectiveWorktreeCheckout,
} from './worktree-identity';
import type { ProjectViewMembership } from '@/lib/projects/project-view-membership';
import { getWorktree, resolveCanonicalWorktree } from './worktrees';

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  has_custom_title: number; // 0 | 1
  provider: string;
  provider_state: string | null;
  model: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  workflow_status?: string | null;
  work_dir: string | null;
  worktree_branch: string | null;
  worktree_managed?: number;
  worktree_id: string | null;
  scope_branch: string | null;
  archived: number; // 0 | 1
  archived_at: string | null;
  worktree_deleted_at: string | null;
  deleted: number; // 0 | 1 — soft-delete flag
  task_id: string | null;
  chat_workflow_status: string | null;
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

interface SessionCursor {
  sortOrder: number;
  projectId: string;
  sessionId: string;
}

export function hasActiveSessionScope(worktreeId: string, branch: string): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.worktree_id = ?
      AND s.scope_branch = ?
      AND ${ACTIVE_SESSION_SCOPE_SQL}
    LIMIT 1
  `).get(worktreeId, branch);
  return Boolean(row);
}

export interface SessionWorktreeContext {
  taskId: string | null;
  workDir: string | null;
  worktreeBranch: string | null;
  worktreeManaged: boolean;
}

export interface ManagedSessionCallerContext {
  projectId: string;
  worktreeId?: string;
}

function isUuidLikeSearchQuery(query: string): boolean {
  return /^[0-9a-f]{6,}(?:-[0-9a-f]*)*$/i.test(query);
}

const SESSION_STATUS_GROUP_SQL = `
  CASE
    WHEN s.task_id IS NULL THEN COALESCE(s.chat_workflow_status, 'chat')
    ELSE COALESCE(t.workflow_status, 'todo')
  END
`;

const SESSION_SELECT_WITH_TASK = `
  SELECT
    s.*,
    CASE
      WHEN s.task_id IS NULL THEN s.chat_workflow_status
      ELSE COALESCE(t.workflow_status, 'todo')
    END AS workflow_status
  FROM sessions s
  LEFT JOIN tasks t ON t.id = s.task_id
  LEFT JOIN projects p ON p.id = s.project_id
`;

// A session leaves the active scope when it is archived on its own, and a
// task-owned session additionally leaves it when the whole task is archived.
const ACTIVE_SESSION_SCOPE_SQL = `
  s.deleted = 0
  AND s.archived = 0
  AND (s.task_id IS NULL OR COALESCE(t.archived, 0) = 0)
`;

function encodeSessionCursor(row: SessionRow): string {
  return Buffer.from(JSON.stringify({
    sortOrder: row.sort_order,
    projectId: row.project_id,
    sessionId: row.id,
  } satisfies SessionCursor)).toString('base64url');
}

function decodeSessionCursor(cursor: string): SessionCursor | number | null {
  if (/^\d+$/.test(cursor)) return Number(cursor);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SessionCursor>;
    if (
      Number.isSafeInteger(parsed.sortOrder)
      && typeof parsed.projectId === 'string'
      && parsed.projectId.length > 0
      && typeof parsed.sessionId === 'string'
      && parsed.sessionId.length > 0
    ) {
      return parsed as SessionCursor;
    }
  } catch {
    // Invalid cursors are rejected by the API and by query entry points below.
  }
  return null;
}

export function isValidSessionCursor(cursor: string): boolean {
  return decodeSessionCursor(cursor) !== null;
}

function cursorPredicate(cursor: string): { sql: string; params: unknown[] } {
  const decoded = decodeSessionCursor(cursor);
  if (decoded === null) throw new Error('Invalid session cursor');
  if (typeof decoded === 'number') {
    return { sql: 's.sort_order > ?', params: [decoded] };
  }
  return {
    sql: `(
      s.sort_order > ?
      OR (
        s.sort_order = ?
        AND (
          s.project_id > ?
          OR (s.project_id = ? AND s.id > ?)
        )
      )
    )`,
    params: [
      decoded.sortOrder,
      decoded.sortOrder,
      decoded.projectId,
      decoded.projectId,
      decoded.sessionId,
    ],
  };
}

const SESSION_CURSOR_ORDER_SQL = 's.sort_order ASC, s.project_id ASC, s.id ASC';

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
  // A session archived on its own is listed as a chat entry. Once its task is
  // archived too, the task entry owns it and lists it as a child session, so it
  // must not appear twice.
  const conditions = [
    's.archived = 1',
    's.deleted = 0',
    '(s.task_id IS NULL OR COALESCE(t.archived, 0) = 0)',
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
    worktreeBranch?: string;
    worktreeManaged?: boolean;
    worktreeId?: string;
    scopeBranch?: string | null;
    taskId?: string;
    collectionId?: string;
    model?: string;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
    providerState?: string | null;
  } = {}
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const checkoutRow = options.taskId
    ? db.prepare(`
        SELECT
          ${PARENT_FIRST_WORKTREE_PATH_SQL} AS worktree_path,
          tasks.worktree_branch AS worktree_branch,
          tasks.public_worktree_id AS public_worktree_id
        FROM tasks
        WHERE tasks.id = ?
      `).get(options.taskId) as {
        worktree_path: string | null;
        worktree_branch: string | null;
        public_worktree_id: string;
      } | undefined
    : undefined;
  const effectiveCheckout = resolveEffectiveWorktreeCheckout(checkoutRow);
  const resolvedWorkDir = effectiveCheckout.path ?? options.workDir;
  const resolvedWorktreeBranch = effectiveCheckout.branch ?? options.worktreeBranch;
  const resolvedWorktreeManaged = effectiveCheckout.path ? true : options.worktreeManaged;
  const resolvedWorktreeId = checkoutRow?.public_worktree_id
    ?? options.worktreeId
    ?? (resolvedWorkDir ? resolveCanonicalWorktree(resolvedWorkDir)?.id : undefined);
  const resolvedScopeBranch = options.scopeBranch !== undefined
    ? options.scopeBranch
    : resolvedWorktreeId
      ? getWorktree(resolvedWorktreeId)?.currentBranch ?? resolvedWorktreeBranch ?? null
      : null;
  // Keep newest Sessions at the top of the canonical Worktree/branch view.
  // Plain non-Git Projects retain their established Project-local ordering.
  if (resolvedWorktreeId) {
    db.prepare(`
      UPDATE sessions SET sort_order = sort_order + 1
      WHERE worktree_id = ?
        AND (
          scope_branch IS NULL
          OR (? IS NOT NULL AND scope_branch = ?)
        )
        AND deleted = 0
    `).run(resolvedWorktreeId, resolvedScopeBranch, resolvedScopeBranch);
  } else {
    db.prepare(`
      UPDATE sessions SET sort_order = sort_order + 1
      WHERE project_id = ? AND deleted = 0
    `).run(projectId);
  }
  db.prepare(`
    INSERT INTO sessions (
      id, project_id, title, provider, provider_state, model, reasoning_effort, service_tier, work_dir, worktree_branch, worktree_managed,
      worktree_id, scope_branch,
      task_id, collection_id, sort_order, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    projectId,
    title,
    provider,
    options.providerState ?? null,
    options.model ?? null,
    options.reasoningEffort ?? null,
    options.serviceTier ?? null,
    resolvedWorkDir ?? null,
    resolvedWorktreeBranch ?? null,
    resolvedWorktreeManaged ? 1 : 0,
    resolvedWorktreeId ?? null,
    resolvedScopeBranch,
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
  deleteTerminalProviderSessionsForTesseraSession(id);
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
 * Sessions a Git action has to refresh: everyone still on screen who shares the
 * working directory the action moved (`docs/design/git-delivery.md` §11).
 *
 * Narrower than `getSessionsByWorkDir` on two counts and wider on a third.
 *
 * Narrower: that one lists anything not deleted, which is right for worktree
 * cleanup and wrong here — an archived session is on no screen, and a shared
 * checkout accumulates hundreds of them, each of which would otherwise cost a
 * full panel recompute per commit.
 *
 * Wider: a task-owned session takes its working directory from the task
 * (`getSessionWorktreeContext`), so it can sit on this tree with an empty
 * `work_dir` of its own. Matching on the session row alone would miss it — the
 * same two-sided lookup `worktree-diff-stats-broadcast.ts:21-26` already does.
 * The task arm resolves the path the one canonical way, so a task that has not
 * stored its own path yet is still matched through its oldest child rather than
 * dropping every childless sibling out of the fan-out.
 */
export function getActiveSessionIdsSharingWorkDir(workDir: string): string[] {
  const rows = getDb()
    .prepare(`
      SELECT s.id AS id
      FROM sessions s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE (
        s.work_dir = ?
        OR (
          s.task_id IS NOT NULL
          AND (
            SELECT ${PARENT_FIRST_WORKTREE_PATH_SQL}
            FROM tasks
            WHERE tasks.id = s.task_id
          ) = ?
        )
      )
      AND ${ACTIVE_SESSION_SCOPE_SQL}
      ORDER BY s.created_at ASC, s.id ASC
    `)
    .all(workDir, workDir) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function getSessionsByTaskId(taskId: string): Array<Pick<SessionRow, 'id' | 'task_id' | 'worktree_branch'>> {
  return getDb().prepare(`
    SELECT id, task_id, worktree_branch
    FROM sessions
    WHERE task_id = ? AND deleted = 0
  `).all(taskId) as Array<Pick<SessionRow, 'id' | 'task_id' | 'worktree_branch'>>;
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
  patch: Partial<Pick<SessionRow, 'title' | 'has_custom_title' | 'model' | 'reasoning_effort' | 'service_tier' | 'work_dir' | 'worktree_branch' | 'worktree_managed' | 'archived' | 'archived_at' | 'worktree_deleted_at' | 'provider_state' | 'task_id' | 'chat_workflow_status' | 'collection_id'>>,
  options?: { skipTimestamp?: boolean }
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
  if (patch.has_custom_title !== undefined) { sets.push('has_custom_title = ?'); values.push(patch.has_custom_title); }
  if (patch.model !== undefined) { sets.push('model = ?'); values.push(patch.model); }
  if (patch.reasoning_effort !== undefined) { sets.push('reasoning_effort = ?'); values.push(patch.reasoning_effort); }
  if (patch.service_tier !== undefined) { sets.push('service_tier = ?'); values.push(patch.service_tier); }
  if (patch.work_dir !== undefined) { sets.push('work_dir = ?'); values.push(patch.work_dir); }
  if (patch.worktree_branch !== undefined) { sets.push('worktree_branch = ?'); values.push(patch.worktree_branch); }
  if (patch.worktree_managed !== undefined) { sets.push('worktree_managed = ?'); values.push(patch.worktree_managed); }
  if (patch.archived !== undefined) { sets.push('archived = ?'); values.push(patch.archived); }
  if (patch.archived_at !== undefined) { sets.push('archived_at = ?'); values.push(patch.archived_at); }
  if (patch.worktree_deleted_at !== undefined) { sets.push('worktree_deleted_at = ?'); values.push(patch.worktree_deleted_at); }
  if (patch.provider_state !== undefined) { sets.push('provider_state = ?'); values.push(patch.provider_state); }
  if (patch.task_id !== undefined) { sets.push('task_id = ?'); values.push(patch.task_id); }
  if (patch.chat_workflow_status !== undefined) { sets.push('chat_workflow_status = ?'); values.push(patch.chat_workflow_status); }
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

/** Resolve a Session's checkout through its parent Worktree when it has one. */
export function getSessionWorktreeContext(id: string): SessionWorktreeContext | null {
  const row = getDb().prepare(`
    SELECT
      s.task_id AS task_id,
      CASE
        WHEN tasks.id IS NULL THEN s.work_dir
        ELSE ${PARENT_FIRST_WORKTREE_PATH_SQL}
      END AS work_dir,
      CASE
        WHEN tasks.id IS NOT NULL
          AND tasks.worktree_branch IS NOT NULL
          AND TRIM(tasks.worktree_branch) <> ''
          THEN tasks.worktree_branch
        ELSE s.worktree_branch
      END AS worktree_branch,
      CASE
        WHEN tasks.id IS NOT NULL
          AND tasks.worktree_path IS NOT NULL
          AND TRIM(tasks.worktree_path) <> ''
          THEN 1
        ELSE s.worktree_managed
      END AS worktree_managed
    FROM sessions s
    LEFT JOIN tasks ON tasks.id = s.task_id
    WHERE s.id = ? AND s.deleted = 0
  `).get(id) as {
    task_id: string | null;
    work_dir: string | null;
    worktree_branch: string | null;
    worktree_managed: number;
  } | undefined;
  if (!row) return null;
  return {
    taskId: row.task_id,
    workDir: row.work_dir,
    worktreeBranch: row.worktree_branch,
    worktreeManaged: row.worktree_managed === 1,
  };
}

/** Public caller identity injected into a managed provider launched for this Session. */
export function getManagedSessionCallerContext(id: string): ManagedSessionCallerContext | null {
  const row = getDb().prepare(`
    SELECT s.project_id, tasks.public_worktree_id
    FROM sessions s
    LEFT JOIN tasks ON tasks.id = s.task_id
    WHERE s.id = ? AND s.deleted = 0
  `).get(id) as {
    project_id: string;
    public_worktree_id: string | null;
  } | undefined;
  if (!row) return null;
  return {
    projectId: row.project_id,
    ...(row.public_worktree_id ? { worktreeId: row.public_worktree_id } : {}),
  };
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

/** Origin-Project representatives used only to number a new placeholder title. */
export function countActiveSessionsInOriginProject(projectId: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.project_id = ? AND ${ACTIVE_SESSION_SCOPE_SQL}
  `).get(projectId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function countArchivedChatSessions(projectId?: string, query?: string): number {
  const where = archivedChatWhere(projectId, query);
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE ${where.sql}
  `).get(...where.params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function projectViewWhere(
  membership: ProjectViewMembership,
): { sql: string; params: unknown[] } {
  if (membership.kind === 'non-git-project') {
    return { sql: 's.project_id = ?', params: [membership.projectId] };
  }

  return {
    sql: `(
      s.worktree_id = ?
      AND (
        s.scope_branch IS NULL
        OR (? IS NOT NULL AND s.scope_branch = ?)
      )
    )`,
    params: [membership.worktreeId, membership.currentBranch, membership.currentBranch],
  };
}

export function setSessionWorktreeDeletedAt(id: string, deletedAt: string): void {
  updateSession(id, { worktree_deleted_at: deletedAt });
}

/**
 * Get sessions for a project with cursor-based pagination.
 * Cursor records the project-local order plus stable cross-project tie-breakers.
 */
export function getSessionsForProjectView(
  membership: ProjectViewMembership,
  options: { limit?: number; cursor?: string } = {}
): SessionQueryResult {
  const db = getDb();
  const limit = options.limit ?? 20;
  const where = projectViewWhere(membership);

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL}
  `).get(...where.params) as { cnt: number };

  let sessions: SessionRow[];
  if (options.cursor) {
    const cursor = cursorPredicate(options.cursor);
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${cursor.sql}
      ORDER BY ${SESSION_CURSOR_ORDER_SQL}
      LIMIT ?
    `).all(...where.params, ...cursor.params, limit) as SessionRow[];
  } else {
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL}
      ORDER BY ${SESSION_CURSOR_ORDER_SQL}
      LIMIT ?
    `).all(...where.params, limit) as SessionRow[];
  }

  const nextCursor = sessions.length === limit
    ? encodeSessionCursor(sessions[sessions.length - 1])
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
export function getSessionsForProjectViewGrouped(
  membership: ProjectViewMembership,
  options: { limitPerStatus?: number } = {}
): {
  sessions: SessionRow[];
  totalCount: number;
  countByStatus: Record<string, number>;
  cursorByStatus: Record<string, string | null>;
  nextCursor: string | null;
} {
  const db = getDb();
  const limitPerStatus = options.limitPerStatus ?? 20;
  const where = projectViewWhere(membership);

  // Get counts per status (exclude archived and soft-deleted)
  const statusCounts = db.prepare(`
    SELECT ${SESSION_STATUS_GROUP_SQL} AS status_group, COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL}
    GROUP BY status_group
  `).all(...where.params) as { status_group: string; cnt: number }[];

  const countByStatus: Record<string, number> = {};
  let totalCount = 0;
  for (const row of statusCounts) {
    countByStatus[row.status_group] = row.cnt;
    totalCount += row.cnt;
  }

  // Get top N sessions per status using UNION ALL
  const statuses = statusCounts.map(r => r.status_group);
  if (statuses.length === 0) {
    return {
      sessions: [],
      totalCount: 0,
      countByStatus,
      cursorByStatus: {},
      nextCursor: null,
    };
  }

  const unions = statuses.map(() =>
    `SELECT * FROM (
      ${SESSION_SELECT_WITH_TASK}
      WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ?
      ORDER BY ${SESSION_CURSOR_ORDER_SQL}
      LIMIT ?
    )`
  ).join(' UNION ALL ');

  const params: unknown[] = [];
  for (const status of statuses) {
    params.push(...where.params, status, limitPerStatus);
  }

  const sessions = db.prepare(unions).all(...params) as SessionRow[];

  const cursorByStatus: Record<string, string | null> = {};
  for (const status of statuses) {
    const statusSessions = sessions.filter((row) => (
      row.task_id === null
        ? (row.workflow_status ?? 'chat')
        : (row.workflow_status ?? 'todo')
    ) === status);
    cursorByStatus[status] = statusSessions.length > 0
      && statusSessions.length < countByStatus[status]
      ? encodeSessionCursor(statusSessions[statusSessions.length - 1])
      : null;
  }

  const lastSession = [...sessions].sort((left, right) => (
    left.sort_order - right.sort_order
    || left.project_id.localeCompare(right.project_id)
    || left.id.localeCompare(right.id)
  )).at(-1);
  const nextCursor = lastSession && sessions.length < totalCount
    ? encodeSessionCursor(lastSession)
    : null;

  return { sessions, totalCount, countByStatus, cursorByStatus, nextCursor };
}

/**
 * Get sessions for a project filtered by sidebar bucket with cursor pagination.
 */
export function getSessionsForProjectViewByStatus(
  membership: ProjectViewMembership,
  statusGroup: string,
  options: { limit?: number; cursor?: string } = {}
): { sessions: SessionRow[]; totalCount: number; nextCursor: string | null } {
  const db = getDb();
  const limit = options.limit ?? 20;
  const where = projectViewWhere(membership);

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ?
  `).get(...where.params, statusGroup) as { cnt: number };

  let sessions: SessionRow[];
  if (options.cursor) {
    const cursor = cursorPredicate(options.cursor);
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ? AND ${cursor.sql}
      ORDER BY ${SESSION_CURSOR_ORDER_SQL}
      LIMIT ?
    `).all(...where.params, statusGroup, ...cursor.params, limit) as SessionRow[];
  } else {
    sessions = db.prepare(`
      ${SESSION_SELECT_WITH_TASK}
      WHERE ${where.sql} AND ${ACTIVE_SESSION_SCOPE_SQL} AND ${SESSION_STATUS_GROUP_SQL} = ?
      ORDER BY ${SESSION_CURSOR_ORDER_SQL}
      LIMIT ?
    `).all(...where.params, statusGroup, limit) as SessionRow[];
  }

  const nextCursor = sessions.length === limit
    ? encodeSessionCursor(sessions[sessions.length - 1])
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
  const kind = extractSessionKind(row.provider_state);
  const hasStarted = isRunning || hasProviderConversationState(row.provider_state) || hasSessionHistoryFile(row.id);
  return {
    id: row.id,
    title: row.title,
    hasCustomTitle: !!row.has_custom_title,
    lastModified: row.updated_at,
    createdAt: row.created_at,
    isRunning,
    isGenerating,
    hasStarted,
    status: isRunning ? ('running' as const) : kind === 'terminal' ? ('stopped' as const) : ('completed' as const),
    projectDir: row.project_id,
    originProjectId: row.project_id,
    workDir: row.work_dir ?? undefined,
    workflowStatus: row.workflow_status ?? undefined,
    worktreeBranch: row.worktree_branch ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
    scopeBranch: row.scope_branch ?? undefined,
    archived: !!row.archived,
    archivedAt: row.archived_at ?? undefined,
    worktreeDeletedAt: row.worktree_deleted_at ?? undefined,
    provider: row.provider,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    serviceTier: row.service_tier ?? undefined,
    kind,
    taskId: row.task_id ?? undefined,
    collectionId: row.collection_id ?? undefined,
    sortOrder: row.sort_order,
  };
}

function hasProviderConversationState(providerState: string | null): boolean {
  if (!providerState) return false;

  try {
    const value = JSON.parse(providerState);
    return (
      typeof value?.threadId === 'string' && value.threadId.trim().length > 0
    ) || (
      typeof value?.opencodeSessionId === 'string' && value.opencodeSessionId.trim().length > 0
    ) || (
      typeof value?.opencodeTerminalSessionId === 'string'
      && value.opencodeTerminalSessionId.trim().length > 0
    );
  } catch {
    return false;
  }
}

function hasSessionHistoryFile(sessionId: string): boolean {
  return fs.existsSync(getTesseraDataPath('session-history', `${sessionId}.jsonl`));
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

/** provider_state.kind ('chat'|'terminal'). 미기록/파싱실패 시 'chat'(기존 동작 보존). */
export function extractSessionKind(providerState: string | null): 'chat' | 'terminal' {
  if (!providerState) return 'chat';
  try {
    return JSON.parse(providerState).kind === 'terminal' ? 'terminal' : 'chat';
  } catch {
    return 'chat';
  }
}

/** codex 터미널 resume용 rollout session_id 추출. */
export function extractCodexTerminalSessionId(providerState: string | null): string | undefined {
  if (!providerState) return undefined;
  try {
    const v = JSON.parse(providerState).codexSessionId;
    return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * codex SessionStart 훅 수신 시 rollout session_id를 provider_state에 병합 기록.
 * chat이 쓴 threadId 등 다른 키는 보존(별도 키 codexSessionId에 저장 → 모드 간 교차 resume 방지).
 * launched=true·kind='terminal'도 세팅.
 */
export function markCodexTerminalSession(sessionId: string, codexSessionId: string): void {
  const id = codexSessionId?.trim();
  if (!id) return;
  const row = getSession(sessionId);
  let prev: Record<string, unknown> = {};
  try { prev = row?.provider_state ? JSON.parse(row.provider_state) : {}; } catch { prev = {}; }
  if (prev.launched === true && prev.codexSessionId === id) return; // idempotent
  updateSession(sessionId, {
    provider_state: JSON.stringify({ ...prev, kind: 'terminal', launched: true, codexSessionId: id }),
  });
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

/** OpenCode PTY 전용 session id. GUI/ACP의 opencodeSessionId와 교차 resume하지 않는다. */
export function extractOpenCodeTerminalSessionId(providerState: string | null): string | undefined {
  if (!providerState) return undefined;
  try {
    const value = JSON.parse(providerState).opencodeTerminalSessionId;
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function markOpenCodeTerminalSession(sessionId: string, opencodeSessionId: string): void {
  const id = opencodeSessionId?.trim();
  if (!id) return;
  const row = getSession(sessionId);
  if (!row) return;
  let prev: Record<string, unknown> = {};
  try { prev = row.provider_state ? JSON.parse(row.provider_state) : {}; } catch { prev = {}; }
  if (prev.launched === true && prev.opencodeTerminalSessionId === id) return;
  updateSession(sessionId, {
    provider_state: JSON.stringify({
      ...prev,
      kind: 'terminal',
      launched: true,
      opencodeTerminalSessionId: id,
    }),
  });
}

/**
 * Touch session updated_at (e.g., when a message is received).
 * Keeps the existing timestamp if the supplied activity timestamp is older.
 */
export function touchSession(id: string, touchedAt = new Date().toISOString()): void {
  getDb().prepare(`
    UPDATE sessions
    SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
    WHERE id = ?
  `).run(touchedAt, touchedAt, id);
}

/**
 * Reorder canonical Sessions by identity. Project Views only choose which IDs
 * are presented; they never own the persisted ordering target.
 */
export function reorderSessionsByIds(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id));
  })();
}
