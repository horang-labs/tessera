import type { TerminalAppearance, TerminalColorSchemeMode } from './types';

export type { TerminalAppearance, TerminalColorSchemeMode } from './types';

type ColorSlot = 10 | 11;

type QueryParseResult =
  | { kind: 'match'; end: number; slots: readonly ColorSlot[] }
  | { kind: 'partial' }
  | { kind: 'none' };

const OSC = '\x1b]';
const ST = '\x1b\\';
const BEL = '\x07';
const MAX_PENDING_QUERY_CHARS = 64;
const MAX_MODE_SCAN_TAIL_CHARS = 128;
// Contour's color-scheme protocol: DEC private mode 2031 subscribes, CSI ?997 reports the mode.
const DYNAMIC_COLOR_SCHEME_MODE = 2031;

export function formatTerminalOscColorReply(slot: ColorSlot, color: string): string | null {
  const match = /^#([\da-f]{6})$/i.exec(color.trim());
  if (!match) return null;

  const [red, green, blue] = match[1].match(/.{2}/g) ?? [];
  if (!red || !green || !blue) return null;
  return `${OSC}${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}${ST}`;
}

export function formatTerminalColorSchemeUpdate(mode: TerminalColorSchemeMode): string {
  return mode === 'dark' ? '\x1b[?997;1n' : '\x1b[?997;2n';
}

export function createTerminalAppearanceController(
  initialAppearance: TerminalAppearance,
  writeReply: (reply: string) => void,
) {
  let appearance = { ...initialAppearance };
  let pendingQuery = '';
  let modeScanTail = '';
  let dynamicColorSchemeSubscribed = false;

  const consumeColorQueries = (data: string): string => {
    const input = pendingQuery + data;
    pendingQuery = '';
    let output = '';
    let offset = 0;

    while (offset < input.length) {
      const candidate = input.indexOf('\x1b', offset);
      if (candidate === -1) {
        output += input.slice(offset);
        break;
      }
      output += input.slice(offset, candidate);

      const parsed = parseColorQuery(input, candidate);
      if (parsed.kind === 'partial') {
        const fragment = input.slice(candidate);
        if (fragment.length <= MAX_PENDING_QUERY_CHARS) pendingQuery = fragment;
        else output += fragment;
        break;
      }
      if (parsed.kind === 'none') {
        output += input[candidate];
        offset = candidate + 1;
        continue;
      }

      const replies = parsed.slots.map((slot) => formatTerminalOscColorReply(
        slot,
        slot === 10 ? appearance.foreground : appearance.background,
      ));
      if (replies.every((reply): reply is string => reply !== null)) {
        try {
          for (const reply of replies) writeReply(reply);
        } catch {
          output += input.slice(candidate, parsed.end);
        }
      } else {
        output += input.slice(candidate, parsed.end);
      }
      offset = parsed.end;
    }

    return output;
  };

  const scanDynamicColorSchemeSubscription = (data: string): void => {
    if (!modeScanTail && !data.includes('\x1b') && !data.includes('\x9b')) return;
    const input = modeScanTail + data;
    modeScanTail = extractPrivateModeScanTail(input);
    const privateModePattern = /\x1b\[\?([0-9;]+)([hl])|\x9b\?([0-9;]+)([hl])/g;
    let match: RegExpExecArray | null;
    while ((match = privateModePattern.exec(input)) !== null) {
      const params = match[1] ?? match[3];
      if (!params.split(';').some((param) => Number(param) === DYNAMIC_COLOR_SCHEME_MODE)) continue;
      if ((match[2] ?? match[4]) === 'h') {
        dynamicColorSchemeSubscribed = true;
        try {
          writeReply(formatTerminalColorSchemeUpdate(appearance.mode));
        } catch {
          // The PTY can exit between emitting the subscription and receiving the seed.
        }
      } else {
        dynamicColorSchemeSubscribed = false;
      }
    }
  };

  return {
    consumeOutput(data: string): string {
      scanDynamicColorSchemeSubscription(data);
      return consumeColorQueries(data);
    },

    drain(): string {
      const output = pendingQuery;
      pendingQuery = '';
      return output;
    },

    getAppearance(): TerminalAppearance {
      return { ...appearance };
    },

    isDynamicColorSchemeSubscribed(): boolean {
      return dynamicColorSchemeSubscribed;
    },

    updateAppearance(nextAppearance: TerminalAppearance): void {
      const modeChanged = appearance.mode !== nextAppearance.mode;
      appearance = { ...nextAppearance };
      if (modeChanged && dynamicColorSchemeSubscribed) {
        try {
          writeReply(formatTerminalColorSchemeUpdate(appearance.mode));
        } catch {
          // Appearance state remains current even if the PTY exited before the flip.
        }
      }
    },
  };
}

function parseColorQuery(data: string, offset: number): QueryParseResult {
  const fragment = data.slice(offset);
  const prefixes = [`${OSC}10;`, `${OSC}11;`] as const;
  const prefix = prefixes.find((candidate) => data.startsWith(candidate, offset));
  if (!prefix) {
    return prefixes.some((candidate) => candidate.startsWith(fragment))
      ? { kind: 'partial' }
      : { kind: 'none' };
  }

  const slot: ColorSlot = prefix === prefixes[0] ? 10 : 11;
  const bodyStart = offset + prefix.length;
  if (bodyStart >= data.length) return { kind: 'partial' };
  if (data[bodyStart] !== '?') return { kind: 'none' };

  let slots: readonly ColorSlot[] = [slot];
  let terminatorStart = bodyStart + 1;
  if (data[terminatorStart] === ';') {
    if (slot !== 10) return { kind: 'none' };
    if (terminatorStart + 1 >= data.length) return { kind: 'partial' };
    if (data[terminatorStart + 1] !== '?') return { kind: 'none' };
    slots = [10, 11];
    terminatorStart += 2;
  }

  if (terminatorStart >= data.length) return { kind: 'partial' };
  if (data[terminatorStart] === BEL) {
    return { kind: 'match', slots, end: terminatorStart + BEL.length };
  }
  if (data.startsWith(ST, terminatorStart)) {
    return { kind: 'match', slots, end: terminatorStart + ST.length };
  }
  if (data[terminatorStart] === '\x1b' && terminatorStart + 1 === data.length) {
    return { kind: 'partial' };
  }
  return { kind: 'none' };
}

function extractPrivateModeScanTail(input: string): string {
  const start = Math.max(input.lastIndexOf('\x1b'), input.lastIndexOf('\x9b'));
  if (start === -1) return '';
  const tail = input.slice(start);
  if (tail.length > MAX_MODE_SCAN_TAIL_CHARS) return '';
  if (tail === '\x1b' || tail === '\x1b[' || tail === '\x9b') return tail;
  if (tail.startsWith('\x1b[?')) {
    return /^[0-9;]*$/.test(tail.slice(3)) ? tail : '';
  }
  if (tail.startsWith('\x9b?')) {
    return /^[0-9;]*$/.test(tail.slice(2)) ? tail : '';
  }
  return '';
}
