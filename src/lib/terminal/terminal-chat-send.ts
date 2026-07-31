/**
 * Sends a message typed in the read-only chat overlay to the PTY underneath.
 *
 * There is no API into a running TUI — the only way in is the keyboard. So a
 * "send" is literally: paste the text, wait, press Enter. Orca does the same
 * (native-chat-runtime-send.ts), and the two rules below are the ones that
 * matter:
 *
 *  - Paste, don't type. xterm wraps the payload in bracketed paste when the TUI
 *    asked for it, so a multi-line message stays one message instead of one
 *    submit per newline.
 *  - Delay the Enter. The TUI needs time to receive and render the pasted body;
 *    an Enter that arrives too early submits a truncated prompt.
 *
 * Text only, by design. Images and file attachments need the TUI's own paste
 * handling and per-agent quirks — those belong in the terminal.
 */

import {
  getSessionTerminalId,
  pasteInputToTerminal,
  sendInputToTerminal,
} from './terminal-surface-registry';

/** Matches Orca's NATIVE_CHAT_SUBMIT_DELAY_MS — enough for a TUI to render the paste. */
export const TERMINAL_CHAT_SUBMIT_DELAY_MS = 500;

/** Carriage return: what Enter actually puts on the wire. */
const SUBMIT_SEQUENCE = '\r';

export interface TerminalChatSendHandle {
  /** Cancels the pending Enter. The pasted body stays in the TUI's input. */
  cancel: () => void;
}

/**
 * Normalizes text for a TUI prompt: CRLF would submit twice, and a trailing
 * newline would submit before the delayed Enter is even sent.
 */
export function normalizeTerminalChatText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/**
 * Pastes `text` into the session's PTY and presses Enter after a short delay.
 * Returns null when no live terminal surface accepted the paste — the caller
 * should surface that rather than pretend the message was sent.
 */
export function sendTerminalChatMessage(
  sessionId: string,
  text: string,
): TerminalChatSendHandle | null {
  const body = normalizeTerminalChatText(text);
  if (!body.trim()) return null;

  const terminalId = getSessionTerminalId(sessionId);
  if (!pasteInputToTerminal(terminalId, body)) return null;

  const timer = setTimeout(() => {
    sendInputToTerminal(terminalId, SUBMIT_SEQUENCE);
  }, TERMINAL_CHAT_SUBMIT_DELAY_MS);

  return { cancel: () => clearTimeout(timer) };
}
