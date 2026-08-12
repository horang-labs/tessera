/**
 * Sends a message typed in the read-only chat overlay to the PTY underneath.
 *
 * There is no provider API into a running TUI — the only way in is the PTY.
 * The server captures the managed runtime for this Session, writes one
 * bracketed paste, then sends Enter only if that exact runtime is still current.
 *
 *  - Paste, don't type. Bracketed paste keeps a multi-line message together.
 *  - Delay the Enter. The TUI needs time to receive and render the pasted body;
 *    an Enter that arrives too early submits a truncated prompt.
 *
 * Text only, by design. Images and file attachments need the TUI's own paste
 * handling and per-agent quirks — those belong in the terminal.
 */

import { wsClient } from '@/lib/ws/client';
import {
  getSessionTerminalId,
  sendInputToTerminal,
  terminalSupportsEscapeInterrupt,
} from './terminal-surface-registry';
import {
  normalizeSemanticPrompt,
  terminalNamedKeySequence,
} from './session-control-input';

export { normalizeSemanticPrompt as normalizeTerminalChatText } from './session-control-input';

export interface TerminalChatSendHandle {
  /** Whether the server submitted Enter to the same runtime that received the paste. */
  submitted: Promise<boolean>;
}

/**
 * Normalizes text for a TUI prompt: CRLF would submit twice, and a trailing
 * newline would submit before the delayed Enter is even sent.
 */
/**
 * Asks the server to paste `text` into the managed Session PTY and submit it.
 * Returns null when the transport is disconnected; the acknowledgement later
 * reports whether the complete submission was written to that exact runtime.
 */
export function sendTerminalChatMessage(
  sessionId: string,
  text: string,
): TerminalChatSendHandle | null {
  const body = normalizeSemanticPrompt(text);
  if (!body.trim()) return null;

  return wsClient.submitTerminalChatInput(sessionId, body);
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
