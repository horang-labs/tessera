import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

const DEFAULT_SCROLLBACK_ROWS = 5_000;

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
  }

  write(data: string): void {
    if (this.disposed || data.length === 0) return;

    this.writeTail = this.writeTail
      .then(() => new Promise<void>((resolve) => {
        if (this.disposed) {
          resolve();
          return;
        }
        this.terminal.write(data, resolve);
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

  async snapshot(): Promise<{ data: string; cols: number; rows: number }> {
    const boundary = this.writeTail;
    await boundary;
    if (this.disposed) {
      throw new Error('Terminal model is disposed');
    }
    return {
      data: this.serializer.serialize({ scrollback: DEFAULT_SCROLLBACK_ROWS }),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}

function normalizeDimension(value: number): number {
  return Math.max(1, Math.floor(value));
}
