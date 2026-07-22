import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor,
} from './terminal-serialize-absolute-cursor';
import { advancePartialEscapeTail } from './terminal-partial-escape-tail';
import { activateTesseraTerminalUnicodeProvider } from './terminal-unicode-provider';

const DEFAULT_SCROLLBACK_ROWS = 5_000;
/** Rows readVisibleText() scans by default — one screen plus a little history. */
const VISIBLE_TEXT_ROWS = 120;

/**
 * DEC private modes SerializeAddon omits from snapshots. It serializes the
 * mouse tracking protocol (?1000/?1002/?1003) but not the report encoding
 * (?1006 SGR and friends) or wheel emulation (?1007). Replaying such a
 * snapshot downgrades mouse reports to legacy X10 encoding, which TUIs like
 * Claude Code ignore — wheel scroll goes dead until the app happens to
 * re-assert its modes on the next keypress-triggered redraw.
 */
const SNAPSHOT_ONLY_TRACKED_DEC_MODES: readonly number[] = [1005, 1006, 1007, 1015, 1016];
const ALTERNATE_SCREEN_MARKER = '\x1b[?1049h';

export interface TerminalHeadlessSnapshot {
  data: string;
  cols: number;
  rows: number;
  alternateScreen: boolean;
  /** Normal-buffer scrollback captured separately while an alt frame is active. */
  scrollbackAnsi?: string;
  /** Parser state that SerializeAddon cannot represent. Must replay last. */
  pendingEscapeTailAnsi?: string;
}

/**
 * Server-side xterm model used only for cold surface reattachment.
 *
 * Writes are serialized through xterm's public callback API so a snapshot is
 * always taken at a completed parser boundary. Live PTY delivery does not wait
 * for this model; callers pair the snapshot with their own output sequence.
 */
export class TerminalHeadlessModel {
  private readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly pendingWriteCompletions = new Set<() => void>();
  private readonly activeSnapshotOnlyDecModes = new Set<number>();
  private pendingEscapeTail = '';
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols: normalizeDimension(cols),
      rows: normalizeDimension(rows),
      scrollback: DEFAULT_SCROLLBACK_ROWS,
      allowProposedApi: true,
      // Match the live renderer so a cold snapshot reconstructs the same rows.
      convertEol: true,
      logLevel: 'off',
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.terminal.loadAddon(new Unicode11Addon());
    activateTesseraTerminalUnicodeProvider(this.terminal);
    this.trackSnapshotOnlyDecModes();
  }

  /**
   * Mirrors DECSET/DECRST for the modes SerializeAddon cannot see, so
   * snapshot() can replay them. Handlers return false to leave xterm's own
   * processing untouched.
   */
  private trackSnapshotOnlyDecModes(): void {
    const applyModes = (params: (number | number[])[], enabled: boolean): boolean => {
      for (const param of params) {
        const mode = typeof param === 'number' ? param : param[0];
        if (!SNAPSHOT_ONLY_TRACKED_DEC_MODES.includes(mode)) continue;
        if (enabled) this.activeSnapshotOnlyDecModes.add(mode);
        else this.activeSnapshotOnlyDecModes.delete(mode);
      }
      return false;
    };
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => (
      applyModes(params, true)
    ));
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => (
      applyModes(params, false)
    ));
    // RIS (full reset) and DECSTR (soft reset) both clear these modes.
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.activeSnapshotOnlyDecModes.clear();
      return false;
    });
    this.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      this.activeSnapshotOnlyDecModes.clear();
      return false;
    });
  }

  private serializeSnapshotOnlyDecModes(): string {
    return [...this.activeSnapshotOnlyDecModes]
      .sort((left, right) => left - right)
      .map((mode) => `\x1b[?${mode}h`)
      .join('');
  }

  write(data: string): void {
    if (this.disposed || data.length === 0) return;

    this.writeTail = this.writeTail
      .then(() => new Promise<void>((resolve) => {
        if (this.disposed) {
          resolve();
          return;
        }
        let completed = false;
        const complete = () => {
          if (completed) return;
          completed = true;
          this.pendingEscapeTail = advancePartialEscapeTail(this.pendingEscapeTail, data);
          this.pendingWriteCompletions.delete(complete);
          resolve();
        };
        this.pendingWriteCompletions.add(complete);
        try {
          this.terminal.write(data, complete);
        } catch {
          complete();
        }
      }))
      .catch(() => {
        // Keep later writes/snapshots usable after one parser failure. The
        // caller retains a bounded raw replay buffer as a fallback.
      });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(normalizeDimension(cols), normalizeDimension(rows));
  }

  async snapshot(): Promise<TerminalHeadlessSnapshot> {
    const boundary = this.writeTail;
    await boundary;
    if (this.disposed) {
      throw new Error('Terminal model is disposed');
    }

    const alternateScreen = this.terminal.buffer.active.type === 'alternate';
    const combinedData = serializeWithAbsoluteCursor(
      this.serializer,
      this.terminal,
      { scrollback: DEFAULT_SCROLLBACK_ROWS },
      readSavedCursorRegister(this.terminal),
    ) + this.serializeSnapshotOnlyDecModes();
    const split = splitTerminalSnapshotAnsi(combinedData, alternateScreen);
    return {
      data: split.data,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      alternateScreen,
      ...(split.scrollbackAnsi !== undefined && { scrollbackAnsi: split.scrollbackAnsi }),
      ...(this.pendingEscapeTail && { pendingEscapeTailAnsi: this.pendingEscapeTail }),
    };
  }

  /**
   * Plain text of what the user can currently see, newest rows last. Provider
   * adapters read it to recognize screens a CLI only paints on a conversation
   * reset — the one reset signal Codex/OpenCode give at the moment it happens.
   * Wrapped rows are rejoined so a match is not lost to the terminal width.
   */
  readVisibleText(maxRows = VISIBLE_TEXT_ROWS): string {
    if (this.disposed) return '';
    const buffer = this.terminal.buffer.active;
    const end = buffer.baseY + this.terminal.rows;
    const start = Math.max(0, end - Math.max(1, maxRows));
    const rows: string[] = [];
    for (let index = start; index < end; index += 1) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    return rows.join('\n');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const complete of [...this.pendingWriteCompletions]) complete();
    this.terminal.dispose();
  }
}

function normalizeDimension(value: number): number {
  return Math.max(1, Math.floor(value));
}

function splitTerminalSnapshotAnsi(
  snapshotAnsi: string,
  alternateScreen: boolean,
): { data: string; scrollbackAnsi?: string } {
  if (!alternateScreen) return { data: snapshotAnsi };
  const start = snapshotAnsi.lastIndexOf(ALTERNATE_SCREEN_MARKER);
  if (start === -1) return { data: snapshotAnsi };

  return {
    scrollbackAnsi: snapshotAnsi.slice(0, start),
    data: snapshotAnsi.slice(start + ALTERNATE_SCREEN_MARKER.length),
  };
}
