const ESCAPE_CHARACTER = '\x1b';
const SGR_SEQUENCE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[([0-9:;]*)m`, 'g');
const INCOMPLETE_SGR_PATTERN = /^\x1b(?:\[[0-9:;]*)?$/;
const SGR_SCAN_TAIL_MAX_CHARS = 64;

export const TERMINAL_RENDER_RECOVERY_QUIET_MS = 200;

export interface TerminalRenderRecoveryScheduler {
  clearTimeout(id: number): void;
  setTimeout(callback: () => void, delay: number): number;
}

export interface TerminalRendererRecoveryTarget {
  resetWebglTextureAtlas(): void;
  refreshTerminalViewport(): void;
}

const browserScheduler: TerminalRenderRecoveryScheduler = {
  clearTimeout: (id) => window.clearTimeout(id),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
};

function isInRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function sgrParamCode(param: string | undefined): number | null {
  if (!param) return null;
  const [head] = param.split(':');
  const value = Number.parseInt(head ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

function sgrSequenceSetsBackground(params: string): boolean {
  const parts = params.split(';');
  for (let index = 0; index < parts.length; index += 1) {
    const value = sgrParamCode(parts[index]);
    if (value === null) continue;
    if (isInRange(value, 40, 47) || isInRange(value, 100, 107) || value === 48) {
      return true;
    }
    if (value === 38 && !parts[index]?.includes(':')) {
      const mode = sgrParamCode(parts[index + 1]);
      if (mode === 5) index += 2;
      else if (mode === 2) index += 4;
      else index += 1;
    }
  }
  return false;
}

export class TerminalBackgroundSgrDetector {
  private scanTail = '';

  consume(data: string): boolean {
    const candidate = this.scanTail + data;
    this.scanTail = '';
    const lastEscapeIndex = candidate.lastIndexOf(ESCAPE_CHARACTER);
    if (lastEscapeIndex !== -1) {
      const tail = candidate.slice(lastEscapeIndex);
      if (tail.length <= SGR_SCAN_TAIL_MAX_CHARS && INCOMPLETE_SGR_PATTERN.test(tail)) {
        this.scanTail = tail;
      }
    }

    SGR_SEQUENCE_PATTERN.lastIndex = 0;
    for (
      let match = SGR_SEQUENCE_PATTERN.exec(candidate);
      match;
      match = SGR_SEQUENCE_PATTERN.exec(candidate)
    ) {
      if (sgrSequenceSetsBackground(match[1] ?? '')) return true;
    }
    return false;
  }
}

export class QuietTerminalRenderRecovery {
  private timerId: number | null = null;

  constructor(
    private readonly recover: () => void,
    private readonly scheduler: TerminalRenderRecoveryScheduler = browserScheduler,
  ) {}

  request(): void {
    if (this.timerId !== null) this.scheduler.clearTimeout(this.timerId);
    this.timerId = this.scheduler.setTimeout(() => {
      this.timerId = null;
      this.recover();
    }, TERMINAL_RENDER_RECOVERY_QUIET_MS);
  }

  dispose(): void {
    if (this.timerId === null) return;
    this.scheduler.clearTimeout(this.timerId);
    this.timerId = null;
  }
}

/**
 * xterm's WebGL atlas is shared by terminals with matching font settings.
 * Reset every live atlas before rebuilding any viewport render model.
 */
export function resetAndRefreshTerminalRenderers(
  targets: Iterable<TerminalRendererRecoveryTarget>,
): void {
  const targetSnapshot = [...targets];
  for (const target of targetSnapshot) {
    try {
      target.resetWebglTextureAtlas();
    } catch {
      // Best-effort during surface teardown; continue rebuilding live siblings.
    }
  }
  for (const target of targetSnapshot) {
    try {
      target.refreshTerminalViewport();
    } catch {
      // A surface can disappear between the shared reset and viewport refresh.
    }
  }
}
