/**
 * Tiny keyboard-shortcut helpers (pure). A shortcut is stored as a normalized string
 * like "alt+enter" / "meta+shift+enter": modifiers (meta, ctrl, alt, shift) then key.
 */

export interface ParsedShortcut {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  key: string;
}

interface KeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
}

const MODIFIER_EVENT_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift']);

export function parseShortcut(shortcut: string): ParsedShortcut | null {
  if (!shortcut) return null;
  const parts = shortcut.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  let alt = false;
  let ctrl = false;
  let meta = false;
  let shift = false;
  let key = '';
  for (const part of parts) {
    if (part === 'alt' || part === 'option' || part === 'opt') alt = true;
    else if (part === 'ctrl' || part === 'control') ctrl = true;
    else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win') meta = true;
    else if (part === 'shift') shift = true;
    else key = part;
  }
  if (!key) return null;
  return { alt, ctrl, meta, shift, key };
}

/** True if the keyboard event matches the configured shortcut. */
export function matchShortcut(event: KeyEventLike, shortcut: string): boolean {
  const p = parseShortcut(shortcut);
  if (!p) return false;
  return (
    event.altKey === p.alt &&
    event.ctrlKey === p.ctrl &&
    event.metaKey === p.meta &&
    event.shiftKey === p.shift &&
    event.key.toLowerCase() === p.key
  );
}

/**
 * Build a normalized shortcut string from a key event, or null if the event is a bare
 * modifier or has no modifier (we require at least one modifier so the shortcut can't
 * collide with plain typing).
 */
export function eventToShortcut(event: KeyEventLike): string | null {
  if (MODIFIER_EVENT_KEYS.has(event.key)) return null;
  const mods: string[] = [];
  if (event.metaKey) mods.push('meta');
  if (event.ctrlKey) mods.push('ctrl');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  if (mods.length === 0) return null;
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  return [...mods, key].join('+');
}

function formatKey(key: string): string {
  if (key === 'enter') return 'Enter';
  if (key === 'space') return 'Space';
  if (key === 'escape' || key === 'esc') return 'Esc';
  if (key === 'arrowup') return '↑';
  if (key === 'arrowdown') return '↓';
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human-readable shortcut, e.g. "alt+enter" -> "⌥ Enter". */
export function formatShortcut(shortcut: string): string {
  const p = parseShortcut(shortcut);
  if (!p) return '';
  const parts: string[] = [];
  if (p.meta) parts.push('⌘');
  if (p.ctrl) parts.push('⌃');
  if (p.alt) parts.push('⌥');
  if (p.shift) parts.push('⇧');
  parts.push(formatKey(p.key));
  return parts.join(' ');
}
