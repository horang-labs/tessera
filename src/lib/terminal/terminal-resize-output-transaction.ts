const RESIZE_SCROLLBACK_CLEAR_SEQUENCES = ['\x1b[3J', '\x9b3J'] as const;
const MAX_CLEAR_SEQUENCE_LENGTH = Math.max(
  ...RESIZE_SCROLLBACK_CLEAR_SEQUENCES.map((sequence) => sequence.length),
);

interface TerminalResizeOutputTransactionOptions {
  emit: (data: string) => void;
}

/**
 * Owns PTY output from a native resize until the provider's redraw ED3 is
 * consumed (or user input explicitly settles the transaction). Some TUIs emit
 * ED3 while handling SIGWINCH, which would otherwise delete xterm's scrollback
 * before the viewport anchor can be restored.
 *
 * ED3 is removed only inside this transaction. Other redraw instructions (for
 * example ED2) and ED3 emitted outside a resize continue to reach xterm.
 */
export class TerminalResizeOutputTransaction {
  private readonly emit: (data: string) => void;
  private active = false;
  private pendingPrefix = '';
  private pendingResizeClears = 0;
  private settleRequested = false;

  constructor(options: TerminalResizeOutputTransactionOptions) {
    this.emit = options.emit;
  }

  begin(): void {
    this.active = true;
    this.pendingResizeClears += 1;
    this.settleRequested = false;
  }

  accept(data: string): void {
    if (data.length === 0) return;
    if (!this.active) {
      this.emit(data);
      return;
    }

    const { data: filtered, removedClearCount } = this.filterResizeOutput(
      data,
      this.pendingResizeClears,
    );
    if (filtered.length > 0) this.emit(filtered);
    this.pendingResizeClears -= removedClearCount;
    if (
      this.pendingPrefix.length === 0
      && (this.pendingResizeClears === 0 || this.settleRequested)
    ) {
      this.active = false;
      this.pendingResizeClears = 0;
      this.settleRequested = false;
    }
  }

  settle(): void {
    if (this.active && this.pendingPrefix.length > 0) {
      this.settleRequested = true;
      return;
    }
    this.finish();
  }

  dispose(): void {
    this.finish();
  }

  private finish(): void {
    this.active = false;
    this.pendingResizeClears = 0;
    this.settleRequested = false;
    if (this.pendingPrefix.length === 0) return;
    const pending = this.pendingPrefix;
    this.pendingPrefix = '';
    this.emit(pending);
  }

  private filterResizeOutput(
    data: string,
    maximumClearCount: number,
  ): { data: string; removedClearCount: number } {
    const combined = this.pendingPrefix + data;
    this.pendingPrefix = '';

    for (let length = 1; length < MAX_CLEAR_SEQUENCE_LENGTH && length <= combined.length; length += 1) {
      const suffix = combined.slice(-length);
      if (RESIZE_SCROLLBACK_CLEAR_SEQUENCES.some((sequence) => sequence.startsWith(suffix))) {
        this.pendingPrefix = suffix;
      }
    }

    const completeOutput = this.pendingPrefix.length > 0
      ? combined.slice(0, -this.pendingPrefix.length)
      : combined;
    const output: string[] = [];
    let cursor = 0;
    let removedClearCount = 0;
    while (removedClearCount < maximumClearCount) {
      let nextIndex = -1;
      let nextSequence = '';
      for (const sequence of RESIZE_SCROLLBACK_CLEAR_SEQUENCES) {
        const index = completeOutput.indexOf(sequence, cursor);
        if (index >= 0 && (nextIndex < 0 || index < nextIndex)) {
          nextIndex = index;
          nextSequence = sequence;
        }
      }
      if (nextIndex < 0) break;
      output.push(completeOutput.slice(cursor, nextIndex));
      cursor = nextIndex + nextSequence.length;
      removedClearCount += 1;
    }
    output.push(completeOutput.slice(cursor));
    return {
      data: output.join(''),
      removedClearCount,
    };
  }
}
