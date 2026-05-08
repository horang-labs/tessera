/**
 * Task CRUD and query operations backed by SQLite.
 */

import { getDb } from './database';
import logger from '../logger';
import type { WorkflowStatus, TaskEntity, TaskSession } from '@/types/task-entity';
import type { TaskPrState, TaskPrStatus } from '@/types/task-pr-status';

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  collection_id: string | null;
  workflow_status: string;
  worktree_branch: string | null;
  archived: number;
  archived_at: string | null;
  worktree_deleted_at: string | null;
  summary: string | null;
  sort_order: number;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_merged_at: string | null;
  pr_last_synced: string | null;
  pr_unsupported: number;
  remote_branch_exists: number | null;
  pr_head_ref_oid: string | null;
  created_at: string;
  updated_at: string;
}

function readPrStatusFromRow(row: TaskRow): TaskPrStatus | undefined {
  if (row.pr_number === null || row.pr_url === null || row.pr_state === null || row.pr_last_synced === null) {
    return undefined;
  }
  return {
    number: row.pr_number,
    url: row.pr_url,
    state: row.pr_state as TaskPrState,
    mergedAt: row.pr_merged_at ?? undefined,
    lastSynced: row.pr_last_synced,
    headRefOid: row.pr_head_ref_oid ?? undefined,
  };
}

interface SessionForTask {
  id: string;
  title: string;
  provider: string;
  updated_at: string;
}

export interface ArchivedTaskQueryOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

function escapeLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function archivedTaskWhere(
  projectId?: string,
  query?: string,
): { sql: string; params: unknown[] } {
  const conditions = ['t.archived = 1'];
  const params: unknown[] = [];

  if (projectId) {
    conditions.push('t.project_id = ?');
    params.push(projectId);
  }

  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    const pattern = escapeLikePattern(normalizedQuery);
    conditions.push(`(
      t.title LIKE ? ESCAPE '\\'
      OR t.project_id LIKE ? ESCAPE '\\'
      OR COALESCE(t.worktree_branch, '') LIKE ? ESCAPE '\\'
      OR COALESCE(p.display_name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(p.decoded_path, '') LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM sessions s
        WHERE s.task_id = t.id
          AND s.deleted = 0
          AND (
            s.title LIKE ? ESCAPE '\\'
            OR COALESCE(s.work_dir, '') LIKE ? ESCAPE '\\'
          )
      )
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return { sql: conditions.join(' AND '), params };
}

/**
 * Map a TaskRow + child sessions to a TaskEntity.
 */
function mapRowToEntity(
  row: TaskRow,
  sessionData: { sessions: TaskSession[]; workDir?: string; worktreeManaged?: boolean }
): TaskEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    collectionId: row.collection_id ?? undefined,
    workflowStatus: row.workflow_status as WorkflowStatus,
    worktreeBranch: row.worktree_branch ?? undefined,
    workDir: sessionData.workDir,
    worktreeManaged: sessionData.worktreeManaged,
    archived: !!row.archived,
    archivedAt: row.archived_at ?? undefined,
    worktreeDeletedAt: row.worktree_deleted_at ?? undefined,
    summary: row.summary ?? undefined,
    sortOrder: row.sort_order ?? 0,
    prStatus: readPrStatusFromRow(row),
    prUnsupported: !!row.pr_unsupported,
    remoteBranchExists:
      row.remote_branch_exists === null || row.remote_branch_exists === undefined
        ? undefined
        : !!row.remote_branch_exists,
    sessions: sessionData.sessions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Load child sessions for a given task ID.
 */
function loadTaskSessions(
  taskId: string,
  activeSessionIds: Set<string>
): { sessions: TaskSession[]; workDir?: string; worktreeManaged?: boolean } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, title, provider, updated_at, work_dir, worktree_managed
    FROM sessions
    WHERE task_id = ? AND deleted = 0
    ORDER BY updated_at DESC
  `).all(taskId) as (SessionForTask & { work_dir?: string | null; worktree_managed?: number | null })[];

  const sessions = rows.map((r) => ({
    id: r.id,
    title: r.title,
    provider: r.provider,
    lastModified: r.updated_at,
    isRunning: activeSessionIds.has(r.id),
  }));

  // Derive workDir from the first session that has one
  const worktreeRow = rows.find(r => r.work_dir);
  const workDir = worktreeRow?.work_dir ?? undefined;
  const worktreeManaged = workDir
    ? rows.some((r) => r.work_dir === workDir && r.worktree_managed === 1)
    : undefined;

  return { sessions, workDir, worktreeManaged };
}

/**
 * Get all tasks for a project with their child sessions.
 */
export function getTasks(
  projectId: string,
  activeSessionIds: Set<string> = new Set(),
  options: { includeArchived?: boolean } = {}
): TaskEntity[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE project_id = ? ${options.includeArchived ? '' : 'AND archived = 0'}
    ORDER BY sort_order ASC, created_at DESC
  `).all(projectId) as TaskRow[];

  return rows.map((row) =>
    mapRowToEntity(row, loadTaskSessions(row.id, activeSessionIds))
  );
}

/**
 * Get a single task by ID with its child sessions.
 */
export function getTask(
  id: string,
  activeSessionIds: Set<string> = new Set()
): TaskEntity | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return undefined;
  return mapRowToEntity(row, loadTaskSessions(id, activeSessionIds));
}

export function getArchivedTasks(
  activeSessionIds: Set<string> = new Set(),
  projectId?: string,
  options: ArchivedTaskQueryOptions = {},
): TaskEntity[] {
  const db = getDb();
  const where = archivedTaskWhere(projectId, options.query);
  const limitSql = options.limit !== undefined ? 'LIMIT ? OFFSET ?' : '';
  const params = [...where.params];
  if (options.limit !== undefined) {
    params.push(options.limit, options.offset ?? 0);
  }

  const rows = db.prepare(`
    SELECT t.*
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE ${where.sql}
    ORDER BY COALESCE(t.archived_at, t.updated_at) DESC
    ${limitSql}
  `).all(...params) as TaskRow[];

  return rows.map((row) =>
    mapRowToEntity(row, loadTaskSessions(row.id, activeSessionIds))
  );
}

export function countArchivedTasks(projectId?: string, query?: string): number {
  const where = archivedTaskWhere(projectId, query);
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE ${where.sql}
  `).get(...where.params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Create a new task record.
 */
export function createTask(params: {
  id: string;
  projectId: string;
  title: string;
  collectionId?: string;
  workflowStatus?: WorkflowStatus;
  worktreeBranch?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, collection_id, workflow_status, worktree_branch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.projectId,
    params.title,
    params.collectionId ?? null,
    params.workflowStatus ?? 'todo',
    params.worktreeBranch ?? null,
    now,
    now,
  );
  logger.info({ taskId: params.id, projectId: params.projectId }, 'Task created');
}

/**
 * Update task fields. Only provided fields are updated.
 */
export function updateTask(
  id: string,
  patch: Partial<Pick<TaskRow, 'title' | 'collection_id' | 'workflow_status' | 'worktree_branch' | 'archived' | 'archived_at' | 'worktree_deleted_at' | 'summary' | 'sort_order'>>
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  const now = new Date().toISOString();

  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title); }
  if (patch.collection_id !== undefined) { sets.push('collection_id = ?'); values.push(patch.collection_id); }
  if (patch.workflow_status !== undefined) { sets.push('workflow_status = ?'); values.push(patch.workflow_status); }
  if (patch.worktree_branch !== undefined) { sets.push('worktree_branch = ?'); values.push(patch.worktree_branch); }
  if (patch.archived !== undefined) { sets.push('archived = ?'); values.push(patch.archived); }
  if (patch.archived_at !== undefined) { sets.push('archived_at = ?'); values.push(patch.archived_at); }
  if (patch.worktree_deleted_at !== undefined) { sets.push('worktree_deleted_at = ?'); values.push(patch.worktree_deleted_at); }
  if (patch.summary !== undefined) { sets.push('summary = ?'); values.push(patch.summary); }
  if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(patch.sort_order); }

  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.transaction(() => {
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    if (patch.collection_id !== undefined) {
      db.prepare('UPDATE sessions SET collection_id = ?, updated_at = ? WHERE task_id = ?')
        .run(patch.collection_id ?? null, now, id);
    }
  })();
}

/**
 * Move managed worktree tasks from Todo to Doing once a real file diff exists.
 * Existing non-Todo states are left untouched.
 */
export function promoteTodoTasksToInProgress(ids: string[]): string[] {
  const uniqueIds = Array.from(
    new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  );
  if (uniqueIds.length === 0) return [];

  const db = getDb();
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id
    FROM tasks
    WHERE id IN (${placeholders})
      AND workflow_status = 'todo'
      AND archived = 0
      AND worktree_branch IS NOT NULL
      AND worktree_branch <> ''
      AND worktree_deleted_at IS NULL
  `).all(...uniqueIds) as Array<{ id: string }>;

  const promotedIds = rows.map((row) => row.id);
  if (promotedIds.length === 0) return [];

  const updatePlaceholders = promotedIds.map(() => '?').join(', ');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET workflow_status = 'in_progress', updated_at = ?
    WHERE id IN (${updatePlaceholders})
      AND workflow_status = 'todo'
      AND archived = 0
  `).run(now, ...promotedIds);

  logger.info({ taskIds: promotedIds }, 'Auto-promoted tasks to Doing after worktree diff appeared');
  return promotedIds;
}

/** Update the stored worktree branch for a task (used when probe observes
 *  that the worktree's current HEAD has diverged from the DB value). */
export function setTaskWorktreeBranch(id: string, branch: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET worktree_branch = ?, updated_at = ?
    WHERE id = ?
  `).run(branch, now, id);
}

export function setTaskArchived(id: string, archived: boolean): void {
  const db = getDb();
  const now = new Date().toISOString();
  const archivedAt = archived ? now : null;
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET archived = ?, archived_at = ?, updated_at = ?
      WHERE id = ?
    `).run(archived ? 1 : 0, archivedAt, now, id);

    // Task archive state lives on tasks. Child session archive flags are legacy
    // standalone-chat state and must not carry meaning for task-owned sessions.
    db.prepare(`
      UPDATE sessions
      SET archived = 0, archived_at = NULL, updated_at = ?
      WHERE task_id = ?
        AND deleted = 0
        AND (archived != 0 OR archived_at IS NOT NULL)
    `).run(now, id);
  })();
}

/**
 * Replace the PR status block for a task. Set `unsupported` when the task's
 * worktree cannot be synced (no GitHub origin / gh missing) so the UI can
 * hide "pending PR" affordances.
 */
export function setTaskPrStatus(
  id: string,
  input:
    | { unsupported: true }
    | { unsupported: false; prStatus: TaskPrStatus | null; remoteBranchExists?: boolean }
): void {
  const db = getDb();
  if (input.unsupported) {
    db.prepare(`
      UPDATE tasks
      SET pr_number = NULL,
          pr_url = NULL,
          pr_state = NULL,
          pr_merged_at = NULL,
          pr_last_synced = ?,
          pr_unsupported = 1,
          remote_branch_exists = NULL,
          pr_head_ref_oid = NULL
      WHERE id = ?
    `).run(new Date().toISOString(), id);
    return;
  }

  const remoteFlag =
    input.remoteBranchExists === undefined ? null : input.remoteBranchExists ? 1 : 0;
  const pr = input.prStatus;
  if (pr === null) {
    db.prepare(`
      UPDATE tasks
      SET pr_number = NULL,
          pr_url = NULL,
          pr_state = NULL,
          pr_merged_at = NULL,
          pr_last_synced = ?,
          pr_unsupported = 0,
          remote_branch_exists = ?,
          pr_head_ref_oid = NULL
      WHERE id = ?
    `).run(new Date().toISOString(), remoteFlag, id);
    return;
  }

  db.prepare(`
    UPDATE tasks
    SET pr_number = ?,
        pr_url = ?,
        pr_state = ?,
        pr_merged_at = ?,
        pr_last_synced = ?,
        pr_unsupported = 0,
        remote_branch_exists = ?,
        pr_head_ref_oid = ?
    WHERE id = ?
  `).run(
    pr.number,
    pr.url,
    pr.state,
    pr.mergedAt ?? null,
    pr.lastSynced,
    remoteFlag,
    pr.headRefOid ?? null,
    id,
  );
}

export interface TaskPrSyncContext {
  id: string;
  branch: string | null;
  workDir: string | null;
  wasUnsupported: boolean;
  prStatus?: TaskPrStatus;
  remoteBranchExists?: boolean;
}

/** Read everything task-pr-sync needs for a single task in one query. */
export function getTaskPrSyncContext(id: string): TaskPrSyncContext | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      t.id AS id,
      t.worktree_branch AS worktree_branch,
      t.pr_unsupported AS pr_unsupported,
      t.pr_number AS pr_number,
      t.pr_url AS pr_url,
      t.pr_state AS pr_state,
      t.pr_merged_at AS pr_merged_at,
      t.pr_last_synced AS pr_last_synced,
      t.remote_branch_exists AS remote_branch_exists,
      t.pr_head_ref_oid AS pr_head_ref_oid,
      (
        SELECT s.work_dir
        FROM sessions s
        WHERE s.task_id = t.id AND s.work_dir IS NOT NULL
        LIMIT 1
      ) AS work_dir
    FROM tasks t
    WHERE t.id = ?
  `).get(id) as (Pick<TaskRow, 'id' | 'worktree_branch' | 'pr_unsupported' | 'pr_number' | 'pr_url' | 'pr_state' | 'pr_merged_at' | 'pr_last_synced' | 'remote_branch_exists' | 'pr_head_ref_oid'> & { work_dir: string | null }) | undefined;
  if (!row) return null;

  const prStatus: TaskPrStatus | undefined =
    row.pr_number !== null && row.pr_url !== null && row.pr_state !== null && row.pr_last_synced !== null
      ? {
          number: row.pr_number,
          url: row.pr_url,
          state: row.pr_state as TaskPrState,
          mergedAt: row.pr_merged_at ?? undefined,
          lastSynced: row.pr_last_synced,
          headRefOid: row.pr_head_ref_oid ?? undefined,
        }
      : undefined;

  return {
    id: row.id,
    branch: row.worktree_branch,
    workDir: row.work_dir,
    wasUnsupported: !!row.pr_unsupported,
    prStatus,
    remoteBranchExists:
      row.remote_branch_exists === null || row.remote_branch_exists === undefined
        ? undefined
        : !!row.remote_branch_exists,
  };
}

/** Fetch every task that could potentially have PR sync (has a branch, not archived). */
export function getTasksEligibleForPrSync(): Array<Pick<TaskRow, 'id' | 'project_id' | 'worktree_branch' | 'pr_unsupported'> & { work_dir: string | null }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      t.id AS id,
      t.project_id AS project_id,
      t.worktree_branch AS worktree_branch,
      t.pr_unsupported AS pr_unsupported,
      (SELECT s.work_dir FROM sessions s WHERE s.task_id = t.id AND s.work_dir IS NOT NULL LIMIT 1) AS work_dir
    FROM tasks t
    WHERE t.archived = 0
      AND t.worktree_branch IS NOT NULL
      AND t.worktree_deleted_at IS NULL
  `).all() as Array<{
    id: string;
    project_id: string;
    worktree_branch: string | null;
    pr_unsupported: number;
    work_dir: string | null;
  }>;
  return rows;
}

export function setTaskWorktreeDeletedAt(id: string, deletedAt: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET worktree_deleted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(deletedAt, deletedAt, id);
    db.prepare(`
      UPDATE sessions
      SET worktree_deleted_at = ?, updated_at = ?
      WHERE task_id = ? AND deleted = 0
    `).run(deletedAt, deletedAt, id);
  })();
}

/**
 * Delete a task and any remaining child session rows.
 * API callers should delete live child sessions through the session
 * orchestrator first so processes, histories, and managed worktrees are
 * cleaned up before this DB-level fallback runs.
 */
export function deleteTask(id: string): { deletedSessionCount: number } {
  const db = getDb();
  return db.transaction(() => {
    const deleteSessionsResult = db.prepare(
      'DELETE FROM sessions WHERE task_id = ?'
    ).run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    logger.info({ taskId: id, deletedSessionCount: deleteSessionsResult.changes }, 'Task deleted');
    return { deletedSessionCount: deleteSessionsResult.changes };
  })();
}

/**
 * Get the parent task for a session by session ID.
 */
export function getTaskBySessionId(
  sessionId: string,
  activeSessionIds: Set<string> = new Set()
): TaskEntity | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT t.* FROM tasks t
    JOIN sessions s ON s.task_id = t.id
    WHERE s.id = ? AND s.deleted = 0
  `).get(sessionId) as TaskRow | undefined;
  if (!row) return undefined;
  return mapRowToEntity(row, loadTaskSessions(row.id, activeSessionIds));
}

/**
 * Add a session to a task by updating sessions.task_id.
 */
export function addSessionToTask(taskId: string, sessionId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const task = db.prepare('SELECT collection_id FROM tasks WHERE id = ?')
    .get(taskId) as { collection_id: string | null } | undefined;

  db.prepare('UPDATE sessions SET task_id = ?, collection_id = ?, updated_at = ? WHERE id = ?')
    .run(taskId, task?.collection_id ?? null, now, sessionId);
  // Also touch the task's updated_at
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(now, taskId);
  logger.info({ taskId, sessionId }, 'Session added to task');
}

/**
 * Reorder tasks by setting sort_order based on the given ID array order.
 */
export function reorderTasks(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id));
  })();
}

/**
 * Check if a task exists by ID.
 */
export function taskExists(id: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM tasks WHERE id = ?')
    .get(id);
  return row !== undefined;
}
