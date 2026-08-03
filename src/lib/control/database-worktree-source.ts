import { getDb } from '@/lib/db/database';
import { PARENT_FIRST_WORKTREE_PATH_SQL } from '@/lib/db/worktree-identity';
import {
  readPreparationPhase,
  readPreparationStatus,
} from '@/lib/projects/preparation-status-policy';
import type {
  ControlWorktreeRecord,
  ControlWorktreeSessionRecord,
  ControlWorktreeSource,
} from './service';

interface WorktreeRow {
  public_worktree_id: string;
  project_id: string;
  title: string;
  worktree_branch: string | null;
  worktree_path: string | null;
  preparation_status: string | null;
  preparation_phase: string | null;
}

const WORKTREE_PROJECTION_SQL = `
  SELECT public_worktree_id, project_id, title, worktree_branch,
         ${PARENT_FIRST_WORKTREE_PATH_SQL} AS worktree_path,
         preparation_status, preparation_phase
  FROM tasks
`;

export function createDatabaseControlWorktreeSource(): ControlWorktreeSource {
  return {
    list: (projectId) => {
      const rows = getDb().prepare(`
        ${WORKTREE_PROJECTION_SQL}
        WHERE project_id = ?
          AND archived = 0
          AND worktree_deleted_at IS NULL
        ORDER BY sort_order ASC, created_at DESC, id ASC
      `).all(projectId) as WorktreeRow[];
      return rows.map(toControlWorktreeRecord);
    },
    get: (worktreeId) => {
      const row = getDb().prepare(`
        ${WORKTREE_PROJECTION_SQL}
        WHERE public_worktree_id = ?
      `).get(worktreeId) as WorktreeRow | undefined;
      return row ? toControlWorktreeRecord(row) : undefined;
    },
  };
}

function toControlWorktreeRecord(row: WorktreeRow): ControlWorktreeRecord {
  return {
    worktreeId: row.public_worktree_id,
    projectId: row.project_id,
    title: row.title,
    branch: row.worktree_branch,
    filesystemPath: row.worktree_path,
    preparationStatus: readPreparationStatus(row.preparation_status),
    preparationPhase: readPreparationPhase(row.preparation_phase),
    sessions: readSessionSummaries(row.public_worktree_id),
  };
}

function readSessionSummaries(worktreeId: string): ControlWorktreeSessionRecord[] {
  return getDb().prepare(`
    SELECT s.id AS session_id, s.title, s.provider, s.updated_at
    FROM sessions s
    JOIN tasks t ON t.id = s.task_id
    WHERE t.public_worktree_id = ?
      AND s.deleted = 0
      AND s.archived = 0
    ORDER BY s.updated_at DESC, s.id ASC
  `).all(worktreeId).map((row) => {
    const session = row as {
      session_id: string;
      title: string;
      provider: string;
      updated_at: string;
    };
    return {
      sessionId: session.session_id,
      title: session.title,
      provider: session.provider,
      updatedAt: session.updated_at,
    };
  });
}
