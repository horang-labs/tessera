import * as dbSessions from '@/lib/db/sessions';
import { getDb } from '@/lib/db/database';
import {
  type ControlSessionRecord,
  type ControlSessionSource,
} from './service';

interface SessionProjectionRow {
  session_id: string;
  public_worktree_id: string;
  project_id: string;
  title: string;
  provider: string;
  provider_state: string | null;
  model: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  updated_at: string;
}

const SESSION_PROJECTION_SQL = `
  SELECT s.id AS session_id, t.public_worktree_id, s.project_id, s.title,
         s.provider, s.provider_state, s.model, s.reasoning_effort, s.service_tier, s.updated_at
  FROM sessions s
  JOIN tasks t ON t.id = s.task_id
  WHERE s.deleted = 0
    AND s.archived = 0
    AND t.archived = 0
    AND t.worktree_deleted_at IS NULL
`;

export function createDatabaseControlSessionSource(): ControlSessionSource {
  return {
    list: (worktreeId) => (getDb().prepare(`
      ${SESSION_PROJECTION_SQL}
        AND t.public_worktree_id = ?
      ORDER BY s.updated_at DESC, s.id ASC
    `).all(worktreeId) as SessionProjectionRow[])
      .filter(isTerminalProjection)
      .map(toRecord),
    get: (sessionId) => {
      const row = getDb().prepare(`
        ${SESSION_PROJECTION_SQL}
          AND s.id = ?
      `).get(sessionId) as SessionProjectionRow | undefined;
      return row && isTerminalProjection(row) ? toRecord(row) : undefined;
    },
  };
}

function isTerminalProjection(row: SessionProjectionRow): boolean {
  return dbSessions.extractSessionKind(row.provider_state) === 'terminal';
}

function toRecord(row: SessionProjectionRow): ControlSessionRecord {
  return {
    sessionId: row.session_id,
    worktreeId: row.public_worktree_id,
    projectId: row.project_id,
    title: row.title,
    provider: row.provider,
    providerState: row.provider_state,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
    ...(row.service_tier === null ? {} : { serviceTier: row.service_tier }),
    updatedAt: row.updated_at,
  };
}
