import * as dbSessions from '../db/sessions';
import logger from '../logger';

export interface ArchiveSessionResult {
  cleanupError?: string;
  ok: true;
  projectId?: string;
  worktreeRemoved: false;
}

export async function archiveSession(
  sessionId: string,
  archived: boolean,
): Promise<ArchiveSessionResult> {
  const session = dbSessions.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  if (session.task_id) {
    throw new Error('Task sessions must be archived through their task');
  }

  const archivedAt = archived ? new Date().toISOString() : null;
  dbSessions.updateSession(sessionId, {
    archived: archived ? 1 : 0,
    archived_at: archivedAt,
  });

  logger.info({ sessionId, projectId: session.project_id, archived }, 'Session archive state updated');

  return {
    ok: true,
    worktreeRemoved: false,
    projectId: session.project_id,
  };
}
