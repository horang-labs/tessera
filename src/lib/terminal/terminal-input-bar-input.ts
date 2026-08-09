/**
 * What the Terminal input bar puts on the wire.
 *
 * Nothing here defines a byte sequence. Tessera already solved "drive a TUI with no
 * keyboard" for the Control CLI, and `session-control-input.ts` is where that answer
 * lives — the named-key table for keys, `bracketSemanticPrompt` for text. This module
 * only decides *which* of those the bar offers a phone, and in what order.
 */

import {
  bracketSemanticPrompt,
  normalizeSemanticPrompt,
  terminalNamedKeySequence,
  type TerminalNamedKey,
} from './session-control-input';

export interface TerminalInputBarKey {
  namedKey: TerminalNamedKey;
  /** The face of the button — a key's name, so it is not translated. */
  label: string;
  /** i18n key for the accessible name, which does get translated. */
  labelKey: string;
}

/**
 * The five keys, in the order they sit on the bar.
 *
 * Esc, the arrows and Enter answer a provider's permission prompt, the flow a phone was
 * blocked on. Shift+Tab cycles permission mode, which has no other route from a phone.
 *
 * Tab and the left/right arrows are deliberately absent, not forgotten: the bar is
 * buffered, so nothing has reached the PTY for Tab to complete, and the bar is a real
 * textarea, so the phone already owns the caret. Their sequences exist in the named-key
 * table if either turns out to be wrong.
 */
export const TERMINAL_INPUT_BAR_KEYS: readonly TerminalInputBarKey[] = [
  { namedKey: 'escape', label: 'Esc', labelKey: 'chat.terminalInputBar.keyEscape' },
  { namedKey: 'shift-tab', label: '⇧Tab', labelKey: 'chat.terminalInputBar.keyShiftTab' },
  { namedKey: 'up', label: '↑', labelKey: 'chat.terminalInputBar.keyUp' },
  { namedKey: 'down', label: '↓', labelKey: 'chat.terminalInputBar.keyDown' },
  { namedKey: 'enter', label: '⏎', labelKey: 'chat.terminalInputBar.keyEnter' },
];

export function terminalInputBarKeySequence(key: TerminalNamedKey): string {
  return terminalNamedKeySequence(key);
}

/**
 * The bytes for one buffered send, or null when there is nothing to send.
 *
 * Bracketed paste rather than raw typing, for the same reason the chat overlay pastes:
 * a multi-line message stays one message instead of one submit per newline. The wrapping
 * and the ESC neutralisation both come from `bracketSemanticPrompt`.
 *
 * No Enter is appended. The bar carries Enter as its own button, so the text lands in the
 * TUI's own input where the user can read it back before committing — on a phone the
 * composing textarea and the terminal are two separate boxes, and that read-back is the
 * only chance to catch a send that went to the wrong session.
 */
export function terminalInputBarTextPayload(text: string): string | null {
  const body = normalizeSemanticPrompt(text);
  if (!body.trim()) return null;
  return bracketSemanticPrompt(body);
}
