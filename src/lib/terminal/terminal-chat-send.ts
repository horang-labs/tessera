/**
 * Sends a message typed in the read-only chat overlay to the PTY underneath.
 *
 * There is no semantic API inside a running TUI — the server must write the
 * same bracketed paste and delayed Enter that a keyboard would produce. Keeping
 * both writes on the server-owned PTY runtime matters:
 *
 *  - Paste, don't type. Bracketed paste keeps a multi-line message together.
 *  - Delay the Enter. The TUI needs time to receive and render the pasted body;
 *    an Enter that arrives too early submits a truncated prompt.
 *  - Await the Enter. Chat view must not clear its draft until the PTY accepted
 *    both writes.
 *
 * Text only, by design. Images and file attachments need the TUI's own paste
 * handling and per-agent quirks — those belong in the terminal.
 */

import {
  getSessionTerminalId,
  sendInputToTerminal,
  terminalSupportsEscapeInterrupt,
} from './terminal-surface-registry';
import { wsClient } from '@/lib/ws/client';
import type { TerminalPromptSubmitResult } from '@/lib/ws/client-message-handlers';
import {
  normalizeSemanticPrompt,
  terminalNamedKeySequence,
} from './session-control-input';

export { normalizeSemanticPrompt as normalizeTerminalChatText } from './session-control-input';

/**
 * Asks the server-owned session runtime to paste `text` and submit it. The
 * promise settles only after the delayed Enter write is accepted or rejected.
 */
export function sendTerminalChatMessage(
  sessionId: string,
  text: string,
  submissionId: string,
): Promise<TerminalPromptSubmitResult> {
  const body = normalizeSemanticPrompt(text);
  if (!body.trim()) {
    return Promise.resolve({ accepted: false, reason: 'server' });
  }
  return wsClient.submitTerminalPrompt(sessionId, body, submissionId);
}

/** Sends the provider-native interrupt gesture to the live PTY behind chat view. */
export function sendTerminalChatInterrupt(sessionId: string): boolean {
  const terminalId = getSessionTerminalId(sessionId);
  if (!terminalSupportsEscapeInterrupt(terminalId)) return false;
  return sendInputToTerminal(
    terminalId,
    terminalNamedKeySequence('escape'),
  );
}
