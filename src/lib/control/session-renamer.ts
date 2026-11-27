import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import { sessionOrchestrator } from '@/lib/session/session-orchestrator';
import {
  isSessionOperationConflictError,
  isTerminalHandoffConflictError,
} from '@/lib/terminal/terminal-handoff-lock';
import { broadcastSessionMutation } from '@/lib/ws/mutation-broadcast';
import { ControlOperationError, type ControlSessionRenamer } from './service';
import { createRequiredControlUserIdResolver } from './required-user-context';

/** Rename any Session the way the app's own rename does, then refresh every window. */
export function createDatabaseControlSessionRenamer(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
}): ControlSessionRenamer {
  const requireUserId = createRequiredControlUserIdResolver(options);
  return {
    async rename(sessionId, title) {
      const userId = await requireUserId();
      try {
        await sessionOrchestrator.renameSession(userId, sessionId, title);
      } catch (error) {
        if (isSessionOperationConflictError(error) || isTerminalHandoffConflictError(error)) {
          throw new ControlOperationError('SESSION_RENAME_CONFLICT', error.message, 409, {
            sessionId, reason: error.code,
          });
        }
        if (error instanceof Error && error.message === 'Session not found') {
          throw new ControlOperationError('SESSION_NOT_FOUND', 'The requested Session does not exist.', 404, { sessionId });
        }
        logger.error({ sessionId, error }, 'Control Session rename failed');
        throw new ControlOperationError('INSTANCE_UNAVAILABLE', 'The Session could not be renamed.', 500, { sessionId });
      }
      const row = dbSessions.getSession(sessionId);
      broadcastSessionMutation(userId, {
        kind: 'updated',
        projectId: row?.project_id,
        sessionId,
        taskId: row?.task_id ?? undefined,
      });
    },
  };
}
