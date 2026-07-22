/**
 * SerializeAddon restores its final cursor with relative movements. When the
 * last serialized row exactly fills the right margin, replay leaves xterm in
 * wrap-pending state and that relative movement can land one column early.
 * Always finish a non-empty snapshot with the source terminal's authoritative
 * absolute cursor position.
 */

interface SerializeCursorTerminal {
  cols: number;
  rows: number;
  buffer: { active: { cursorX: number; cursorY: number } };
}

interface BufferSerializer<TOptions> {
  serialize(options?: TOptions): string;
}

export interface SavedCursorRegister {
  x: number;
  y: number;
}

interface TerminalWithSavedCursorCore extends SerializeCursorTerminal {
  _core?: {
    buffer?: {
      savedX?: number;
      savedY?: number;
      ybase?: number;
    };
  };
}

/** Read xterm's active-buffer DECSC register in viewport-relative coordinates. */
export function readSavedCursorRegister(
  terminal: SerializeCursorTerminal,
): SavedCursorRegister | null {
  const buffer = (terminal as TerminalWithSavedCursorCore)._core?.buffer;
  if (
    typeof buffer?.savedX !== 'number'
    || typeof buffer.savedY !== 'number'
    || typeof buffer.ybase !== 'number'
  ) {
    return null;
  }

  const y = Math.min(Math.max(buffer.savedY - buffer.ybase, 0), terminal.rows - 1);
  const x = Math.min(Math.max(buffer.savedX, 0), terminal.cols - 1);
  // Home is also xterm's never-saved default. Avoid replacing the fresh
  // terminal's default saved SGR/charset when no explicit save was observed.
  return x === 0 && y === 0 ? null : { x, y };
}

export function serializeWithAbsoluteCursor<TOptions>(
  serializer: BufferSerializer<TOptions>,
  terminal: SerializeCursorTerminal,
  options?: TOptions,
  savedCursor: SavedCursorRegister | null = null,
): string {
  const serialized = serializer.serialize(options);
  if (serialized.length === 0) return serialized;

  const { cursorX, cursorY } = terminal.buffer.active;
  // CUP cannot recreate xterm's wrap-pending cursor (cursorX === cols). Plain
  // replay already preserves that state, so leave those snapshots untouched.
  if (
    cursorX < 0
    || cursorX >= terminal.cols
    || cursorY < 0
    || cursorY >= terminal.rows
  ) {
    return serialized;
  }

  const savedCursorSequence = savedCursor
    ? `\x1b[${savedCursor.y + 1};${savedCursor.x + 1}H\x1b7`
    : '';
  return `${serialized}${savedCursorSequence}\x1b[${cursorY + 1};${cursorX + 1}H`;
}
