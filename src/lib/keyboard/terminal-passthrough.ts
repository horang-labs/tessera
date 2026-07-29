/**
 * Terminal passthrough for app-level shortcuts.
 *
 * xterm cancels (preventDefault + stopPropagation) most modifier keydowns it
 * inspects, so registered app shortcuts never reach the window-level tinykeys
 * listener while a terminal has focus. use-keyboard-shortcuts publishes the
 * effective shortcut set here; the terminal surface's custom key event handler
 * consults it and returns false for matches, letting the event bubble out of
 * xterm untouched (and keeping it out of the PTY).
 */
import { matchKeyBindingPress, parseKeybinding, type KeyBindingPress } from 'tinykeys';

let activePresses: KeyBindingPress[] = [];

export function setGlobalShortcutKeys(keys: string[]): void {
  // Multi-chord sequences are excluded: swallowing only the first chord of a
  // sequence would drop real terminal input without ever firing the shortcut.
  activePresses = keys
    .map((key) => parseKeybinding(key))
    .filter((chords) => chords.length === 1)
    .map((chords) => chords[0]);
}

export function isGlobalShortcutKeydown(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false;
  // A keydown delivered mid-composition reports the IME's placeholder key, not
  // the physical one. Matching that against a shortcut would both swallow the
  // keystroke and return false from the custom key handler, which stops xterm
  // from ever advancing its composition state machine for that event.
  if (event.isComposing) return false;
  return activePresses.some((press) => matchKeyBindingPress(event, press));
}
