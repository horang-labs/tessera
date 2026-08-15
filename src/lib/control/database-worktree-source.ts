import { getDb } from '@/lib/db/database';
import { createTask } from '@/lib/db/tasks';
import { PARENT_FIRST_WORKTREE_PATH_SQL } from '@/lib/db/worktree-identity';
import { randomUUID } from 'node:crypto';
import {
  readPreparationPhase,
  readPreparationStatus,
} from '@/lib/projects/preparation-status-policy';
import { getProjectViewWorktrees } from '@/lib/projects/project-view-projection';
import type { TaskSession } from '@/types/task-entity';
import type {
  ControlWorktreeRecord,
  ControlWorktreeSessionRecord,
  ControlWorktreeSource,
} from './service';
import type { WorktreeCreationScope } from '@/lib/db/tasks';

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
      return getProjectViewWorktrees(projectId).flatMap((task) => {
        if (!task.worktreeId || task.worktreeDeletedAt) return [];
        const row = getDb().prepare(`
          ${WORKTREE_PROJECTION_SQL}
          WHERE public_worktree_id = ?
        `).get(task.worktreeId) as WorktreeRow | undefined;
        return row ? [toControlWorktreeRecord(row, task.sessions)] : [];
      });
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

export function persistDatabaseControlWorktree(input: {
  projectId: string;
  title: string;
  branch: string;
  filesystemPath: string;
  creationScope?: WorktreeCreationScope;
  startPoint?: string;
}): { taskId: string; worktree: ControlWorktreeRecord } {
  const taskId = `task_${randomUUID()}`;
  const worktreeId = createTask({
    id: taskId,
    projectId: input.projectId,
    title: input.title,
    worktreeBranch: input.branch,
    worktreePath: input.filesystemPath,
    creationScope: input.creationScope,
    startPoint: input.startPoint,
  });
  const worktree = createDatabaseControlWorktreeSource().get(worktreeId);
  if (!worktree) {
    throw new Error('The persisted Worktree could not be read back.');
  }
  return { taskId, worktree };
}

function toControlWorktreeRecord(
  row: WorktreeRow,
  projectedSessions?: TaskSession[],
): ControlWorktreeRecord {
  return {
    worktreeId: row.public_worktree_id,
    projectId: row.project_id,
    title: row.title,
    branch: row.worktree_branch,
    filesystemPath: row.worktree_path,
    preparationStatus: readPreparationStatus(row.preparation_status),
    preparationPhase: readPreparationPhase(row.preparation_phase),
    sessions: projectedSessions
      ? projectedSessions.map((session) => ({
          sessionId: session.id,
          title: session.title,
          provider: session.provider ?? 'unknown',
          updatedAt: session.lastModified,
        }))
      : readSessionSummaries(row.public_worktree_id),
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
