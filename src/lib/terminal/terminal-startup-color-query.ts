import type { TerminalColorQueryColors } from './types';

type ColorSlot = 10 | 11;

type QueryParseResult =
  | { kind: 'match'; end: number; slots: readonly ColorSlot[] }
  | { kind: 'partial' }
  | { kind: 'none' };

const OSC = '\x1b]';
const ST = '\x1b\\';
const BEL = '\x07';
const MAX_PENDING_CHARS = 64;
const STARTUP_WINDOW_MS = 5_000;

/** Format the same 16-bit-channel X11 color response emitted by xterm. */
export function formatTerminalOscColorReply(slot: ColorSlot, color: string): string | null {
  const match = /^#([\da-f]{6})$/i.exec(color.trim());
  if (!match) return null;

  const [red, green, blue] = match[1].match(/.{2}/g) ?? [];
  if (!red || !green || !blue) return null;
  return `${OSC}${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}${ST}`;
}

/**
 * Answer an agent's initial OSC 10/11 probes before its output reaches the
 * browser. The short-lived bridge prevents a startup race where a TUI times
 * out before the renderer can report the active light/dark terminal colors.
 */
export function createTerminalStartupColorQueryBridge(
  colors: TerminalColorQueryColors,
  writeReply: (reply: string) => void,
  now: () => number = Date.now,
) {
  const replies = {
    10: formatTerminalOscColorReply(10, colors.foreground),
    11: formatTerminalOscColorReply(11, colors.background),
  } as const;
  const enabled = Boolean(replies[10] && replies[11]);
  const expiresAt = now() + STARTUP_WINDOW_MS;
  const answered = new Set<ColorSlot>();
  let pending = '';

  const consume = (data: string): string => {
    if (!enabled || answered.size === 2 || now() > expiresAt) {
      const output = pending + data;
      pending = '';
      return output;
    }

    const input = pending + data;
    pending = '';
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
        if (fragment.length <= MAX_PENDING_CHARS) pending = fragment;
        else output += fragment;
        break;
      }
      if (parsed.kind === 'none') {
        output += input[candidate];
        offset = candidate + 1;
        continue;
      }

      try {
        for (const slot of parsed.slots) {
          const reply = replies[slot];
          if (!reply) throw new Error('Missing terminal color reply');
          writeReply(reply);
          answered.add(slot);
        }
      } catch {
        output += input.slice(candidate, parsed.end);
      }
      offset = parsed.end;
    }

    return output;
  };

  return {
    consume,
    drain(): string {
      const output = pending;
      pending = '';
      return output;
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
