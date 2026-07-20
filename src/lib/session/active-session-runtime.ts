import { processManager } from '@/lib/cli/process-manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import logger from '@/lib/logger';
import { createActiveSessionRuntimeController } from './active-session-runtime-controller';

const activeSessionRuntimeController = createActiveSessionRuntimeController({
  getGuiSessionIds: (userId) => userId === undefined
    ? processManager.getActiveSessionIds()
    : new Set(processManager.getUserProcesses(userId).map((process) => process.sessionId)),
  getPtySessionIds: (userId) => terminalManager.getActiveSessionIds(userId),
  closeGuiSession: (sessionId) => processManager.closeSession(sessionId),
  closePtySession: (sessionId, userId) => terminalManager.closeSession(sessionId, userId),
});

/** All sessions with a live backing runtime, regardless of GUI or PTY execution mode. */
export function getActiveSessionIds(userId?: string): Set<string> {
  return activeSessionRuntimeController.getActiveSessionIds(userId);
}

/** Stop every backing runtime for a session without letting one backend mask another. */
export async function closeSessionRuntimes(sessionId: string, userId?: string): Promise<void> {
  const failures = await activeSessionRuntimeController.closeSession(sessionId, userId);
  for (const failure of failures) {
    logger.warn(
      { sessionId, userId, runtime: failure.runtime, error: failure.error },
      'Session runtime did not stop cleanly',
    );
  }
}
