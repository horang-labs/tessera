import logger from '@/lib/logger';
import * as dbSessions from '@/lib/db/sessions';
import { broadcastSessionMutation } from '@/lib/ws/mutation-broadcast';
import type { TerminalManager } from './terminal-manager';
import { createPendingTerminalProviderSessionFork } from './provider-session-reconciliation';

/**
 * Moves a PTY to a fresh Tessera session the moment its agent is told to reset
 * the conversation, without waiting for a provider session id that Codex and
 * OpenCode only mint on the next prompt.
 *
 * The rebind is the whole point: the live PTY keeps running while its ownership
 * moves, so the sidebar shows the new conversation immediately and the old one
 * keeps the transcript it already has.
 */
export function forkTerminalSessionForProviderReset(options: {
  manager: TerminalManager;
  terminalId: string;
  userId: string;
}): string | null {
  const { manager, terminalId, userId } = options;
  const sourceSessionId = manager.getSessionIdForTerminal(terminalId, userId);
  if (!sourceSessionId) return null;

  const fork = createPendingTerminalProviderSessionFork(sourceSessionId);
  if (!fork) return null;

  if (!manager.rebindSession(terminalId, userId, sourceSessionId, fork.sessionId)) {
    // The PTY moved (or died) between the keystroke and here — the placeholder
    // would never be adopted by anything, so it must not survive.
    dbSessions.deleteSession(fork.sessionId);
    return null;
  }

  manager.clearProviderSessionIdentity(terminalId, userId);
  broadcastSessionMutation(userId, { kind: 'created', projectId: fork.projectId });
  logger.info({
    previousSessionId: sourceSessionId,
    sessionId: fork.sessionId,
    terminalId,
  }, 'Terminal provider session reset forked ahead of the provider');
  return fork.sessionId;
}
