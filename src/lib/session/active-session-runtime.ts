import { processManager } from '@/lib/cli/process-manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';

/** All sessions with a live backing runtime, regardless of GUI or PTY execution mode. */
export function getActiveSessionIds(userId?: string): Set<string> {
  const guiSessionIds = userId === undefined
    ? processManager.getActiveSessionIds()
    : new Set(processManager.getUserProcesses(userId).map((process) => process.sessionId));
  return new Set([
    ...guiSessionIds,
    ...terminalManager.getActiveSessionIds(userId),
  ]);
}
