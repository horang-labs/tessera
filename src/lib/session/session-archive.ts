import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { withExclusiveTesseraSessionOperation } from '../terminal/terminal-handoff-lock';
import { closeSessionRuntimes } from './active-session-runtime';
import { syncCodexThreadsArchived } from './codex-thread-lifecycle';

export interface ArchiveSessionResult {
  cleanupError?: string;
  ok: true;
  projectId?: string;
  worktreeRemoved: false;
}

export async function archiveSession(
  sessionId: string,
  archived: boolean,
  userId?: string,
): Promise<ArchiveSessionResult> {
  return withExclusiveTesseraSessionOperation(sessionId, async () => {
    const session = dbSessions.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.task_id) {
      throw new Error('Task sessions must be archived through their task');
    }

    await syncCodexThreadsArchived([session], archived, userId);
    try {
      const archivedAt = archived ? new Date().toISOString() : null;
      dbSessions.updateSession(sessionId, {
        archived: archived ? 1 : 0,
        archived_at: archivedAt,
      });
    } catch (error) {
      try {
        await syncCodexThreadsArchived([session], !archived, userId);
      } catch (compensationError) {
        logger.error({ sessionId, archived, error: compensationError }, 'Failed to compensate Codex archive state');
      }
      throw error;
    }

    if (archived) {
      await closeSessionRuntimes(sessionId, userId);
    }

    logger.info({ sessionId, projectId: session.project_id, archived }, 'Session archive state updated');

    return {
      ok: true,
      worktreeRemoved: false,
      projectId: session.project_id,
    };
  });
}
