import type { Panel } from '@/types/panel';
import { escapeShellPath } from './shell-path-escape';
import { getSessionTerminalId, sendInputToTerminal } from './terminal-surface-registry';

/**
 * Resolve the PTY terminal id a panel's prompt writes to, or null when the
 * panel does not host a terminal. Plain shell panes carry `terminalId`
 * directly; CLI terminal sessions are identified by the caller via the
 * session's kind (panel state alone cannot tell chat from terminal sessions).
 */
export function resolvePanelTerminalId(
  panel: Panel | undefined,
  isTerminalSession: (sessionId: string) => boolean,
): string | null {
  if (!panel) return null;
  if (panel.terminalId) return panel.terminalId;
  if (panel.sessionId && isTerminalSession(panel.sessionId)) {
    return getSessionTerminalId(panel.sessionId);
  }
  return null;
}

/**
 * Insert a file path (plus a trailing space) into a running terminal, as if
 * the user had typed it at the prompt.
 */
export function insertFilePathIntoTerminal(terminalId: string, path: string): boolean {
  const escaped = escapeShellPath(path);
  if (!escaped) return false;
  return sendInputToTerminal(terminalId, `${escaped} `);
}
