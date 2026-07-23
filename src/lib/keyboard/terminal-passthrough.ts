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
  return activePresses.some((press) => matchKeyBindingPress(event, press));
}
