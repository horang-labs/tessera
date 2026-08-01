/**
 * Reads and writes a task's preparation status.
 *
 * The status belongs to the worktree, and a task is what owns a worktree — a
 * worktree can back several sessions, so a session-level status would disagree
 * with itself. Every write asks `preparation-status-policy` whether the event
 * applies first, so a late completion can never clear a failure.
 */

import { getDb } from './database';
import logger from '../logger';
import {
  applyPreparationEvent,
  readPreparationStatus,
  type PreparationEvent,
  type PreparationStatus,
} from '@/lib/projects/preparation-status-policy';

/** Enough of the tail to show why a run failed, without storing a build log. */
const MAX_STORED_OUTPUT_CHARS = 64 * 1024;

export interface TaskPreparation {
  taskId: string;
  status: PreparationStatus;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  output: string | null;
  /**
   * The script this run ran, as it ran it. Stored with the run rather than read
   * back from the project, because the project's script is edited — often
   * because this very run went wrong — and the log would then sit next to a
   * script that never produced it.
   */
  script: string | null;
}

interface TaskPreparationRow {
  id: string;
  preparation_status: string | null;
  preparation_started_at: string | null;
  preparation_finished_at: string | null;
  preparation_exit_code: number | null;
  preparation_output: string | null;
  preparation_script: string | null;
}

export interface TaskPreparationContext {
  taskId: string;
  /** The original checkout the worktree was created from. */
  projectDir: string;
  branchName: string | null;
  /** The worktree itself, taken from a session that works in it. */
  worktreePath: string | null;
}

/** Read everything a re-run needs to start the same preparation again. */
export function getTaskPreparationContext(taskId: string): TaskPreparationContext | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      t.id AS id,
      t.project_id AS project_id,
      t.worktree_branch AS worktree_branch,
      (
        SELECT s.work_dir
        FROM sessions s
        WHERE s.task_id = t.id AND s.work_dir IS NOT NULL AND s.deleted = 0
        LIMIT 1
      ) AS work_dir
    FROM tasks t
    WHERE t.id = ?
  `).get(taskId) as {
    id: string;
    project_id: string;
    worktree_branch: string | null;
    work_dir: string | null;
  } | undefined;

  if (!row) return null;
  return {
    taskId: row.id,
    projectDir: row.project_id,
    branchName: row.worktree_branch,
    worktreePath: row.work_dir,
  };
}

export function getTaskPreparation(taskId: string): TaskPreparation | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, preparation_status, preparation_started_at, preparation_finished_at,
           preparation_exit_code, preparation_output, preparation_script
    FROM tasks
    WHERE id = ?
  `).get(taskId) as TaskPreparationRow | undefined;

  if (!row) return null;
  return {
    taskId: row.id,
    status: readPreparationStatus(row.preparation_status),
    startedAt: row.preparation_started_at,
    finishedAt: row.preparation_finished_at,
    exitCode: row.preparation_exit_code,
    output: row.preparation_output,
    script: row.preparation_script,
  };
}

/**
 * Record that a run is starting, unless one already is.
 *
 * Returns false when the task is gone or a run is already in flight, which is
 * the caller's signal not to spawn anything. The read and the write need no
 * transaction between them: this runs to completion without yielding, and the
 * database is in-process, so no second claim can land in the middle.
 */
export function startTaskPreparation(taskId: string, script: string): boolean {
  const current = getTaskPreparation(taskId);
  if (!current) return false;

  const transition = applyPreparationEvent(current.status, { kind: 'start' });
  if (!transition.accepted) return false;

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET preparation_status = ?, preparation_started_at = ?, preparation_finished_at = NULL,
        preparation_exit_code = NULL, preparation_output = NULL, preparation_script = ?,
        updated_at = ?
    WHERE id = ?
  `).run(transition.status, now, script, now, taskId);
  return true;
}

/**
 * Record how a run ended. Returns false when it was ignored — the run is no
 * longer the current one, so its outcome is stale.
 */
export function finishTaskPreparation(
  taskId: string,
  exitCode: number,
  output: string,
): boolean {
  return applyCompletion(taskId, { kind: 'finish', exitCode }, exitCode, output);
}

/**
 * Mark every run that was in flight as failed.
 *
 * Called once at startup: a PTY does not survive the app, so a status left
 * saying `running` describes a process that no longer exists, and its worktree
 * may well be half prepared.
 */
export function interruptRunningPreparations(): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id FROM tasks WHERE preparation_status = 'running'
  `).all() as Array<{ id: string }>;

  for (const row of rows) {
    // No exit code and no output: the process was never waited on. That pair is
    // what tells a reader afterwards that the app, not the script, ended it.
    applyCompletion(row.id, { kind: 'interrupt' }, null, null);
  }

  if (rows.length > 0) {
    logger.info({ taskCount: rows.length }, 'Preparation runs interrupted by an app restart');
  }
  return rows.length;
}

function applyCompletion(
  taskId: string,
  event: PreparationEvent,
  exitCode: number | null,
  output: string | null,
): boolean {
  const current = getTaskPreparation(taskId);
  if (!current) return false;

  const transition = applyPreparationEvent(current.status, event);
  if (!transition.accepted) return false;

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET preparation_status = ?, preparation_finished_at = ?, preparation_exit_code = ?,
        preparation_output = ?, updated_at = ?
    WHERE id = ?
  `).run(transition.status, now, exitCode, truncateOutput(output), now, taskId);
  return true;
}

/** Keep the tail: a failure explains itself at the end of the output, not the start. */
function truncateOutput(output: string | null): string | null {
  if (output === null) return null;
  return output.length > MAX_STORED_OUTPUT_CHARS
    ? output.slice(-MAX_STORED_OUTPUT_CHARS)
    : output;
}
