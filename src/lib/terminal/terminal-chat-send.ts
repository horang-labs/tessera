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
  terminalSupportsEscapeInterrupt,
} from './terminal-surface-registry';
import {
  normalizeSemanticPrompt,
  terminalNamedKeySequence,
} from './session-control-input';

export { normalizeSemanticPrompt as normalizeTerminalChatText } from './session-control-input';

/** Matches Orca's NATIVE_CHAT_SUBMIT_DELAY_MS — enough for a TUI to render the paste. */
export const TERMINAL_CHAT_SUBMIT_DELAY_MS = 500;

/** Carriage return: what Enter actually puts on the wire. */
const SUBMIT_SEQUENCE = '\r';

export interface TerminalChatSendHandle {
  /** Cancels the pending Enter. The pasted body stays in the TUI's input. */
  cancel: () => void;
  /** Whether Enter reached the same live surface generation that received the paste. */
  submitted: Promise<boolean>;
}

/**
 * Normalizes text for a TUI prompt: CRLF would submit twice, and a trailing
 * newline would submit before the delayed Enter is even sent.
 */
/**
 * Pastes `text` into the session's PTY and presses Enter after a short delay.
 * Returns null when no live terminal surface accepted the paste — the caller
 * should surface that rather than pretend the message was sent.
 */
export function sendTerminalChatMessage(
  sessionId: string,
  text: string,
): TerminalChatSendHandle | null {
  const body = normalizeSemanticPrompt(text);
  if (!body.trim()) return null;

  const terminalId = getSessionTerminalId(sessionId);
  const route = pasteInputToTerminal(terminalId, body);
  if (!route) return null;

  let resolveSubmitted!: (submitted: boolean) => void;
  const submitted = new Promise<boolean>((resolve) => {
    resolveSubmitted = resolve;
  });
  const timer = setTimeout(() => {
    resolveSubmitted(route.send(SUBMIT_SEQUENCE));
  }, TERMINAL_CHAT_SUBMIT_DELAY_MS);

  return {
    submitted,
    cancel: () => {
      clearTimeout(timer);
      resolveSubmitted(false);
    },
  };
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
