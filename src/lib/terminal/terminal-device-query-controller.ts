/**
 * Answers the device queries a TUI emits at startup (CPR, DSR, primary DA)
 * from the server, mirroring how the appearance controller answers OSC colors.
 *
 * Why this exists: these queries are answered by the terminal emulator, and
 * tessera's emulator is the browser's xterm instance — a WebSocket round trip
 * away, and absent entirely until a surface attaches. A reply that arrives
 * after the querying program stopped reading lands on the tty with ECHO still
 * enabled, which paints it as literal `^[[1;1R` on screen (codex emits
 * `CSI 6n` the moment it starts). Consuming the query here means the browser
 * never sees it, never synthesizes a late reply, and the program gets its
 * answer immediately without leaving the machine.
 *
 * Scope is deliberately limited to queries whose answer is fully determined by
 * state the server already owns. Kitty keyboard flags (`CSI ? u`) are left
 * alone on purpose: the honest answer depends on what the browser emulator
 * supports, so faking one here could tell a TUI to use an encoding the real
 * emulator cannot produce.
 */

const CSI = '\x1b[';
// Long enough to hold any CSI sequence split across PTY chunks; a fragment
// past this is flushed as ordinary output rather than buffered forever.
const MAX_PENDING_QUERY_CHARS = 64;

export type TerminalDeviceQueryKind =
  | 'cursor-position'
  | 'extended-cursor-position'
  | 'device-status'
  | 'primary-device-attributes';

export type TerminalDeviceQueryCursor = {
  /** 1-based row, as CPR reports it. */
  row: number;
  /** 1-based column, as CPR reports it. */
  column: number;
};

type CsiParseResult =
  | { kind: 'match'; sequence: string }
  | { kind: 'partial' }
  | { kind: 'none' };

/**
 * A chunk split at its query boundaries. `output` is everything that preceded
 * `query` in the chunk, so a caller can apply that output before reading the
 * state a cursor report has to describe.
 */
export type TerminalDeviceQuerySegment = {
  output: string;
  query: TerminalDeviceQueryKind | null;
};

const QUERY_BY_SEQUENCE = new Map<string, TerminalDeviceQueryKind>([
  [`${CSI}6n`, 'cursor-position'],
  [`${CSI}?6n`, 'extended-cursor-position'],
  [`${CSI}5n`, 'device-status'],
  [`${CSI}c`, 'primary-device-attributes'],
  [`${CSI}0c`, 'primary-device-attributes'],
]);

/**
 * Formats the reply for a consumed query. The device-attributes answer matches
 * what xterm.js reports (`VT100 with Advanced Video Option`) so a program sees
 * the same terminal identity whether the server or the browser answered.
 */
export function formatTerminalDeviceQueryReply(
  kind: TerminalDeviceQueryKind,
  cursor: TerminalDeviceQueryCursor,
): string {
  const row = Math.max(1, Math.trunc(cursor.row));
  const column = Math.max(1, Math.trunc(cursor.column));

  switch (kind) {
    case 'cursor-position':
      return `${CSI}${row};${column}R`;
    case 'extended-cursor-position':
      return `${CSI}?${row};${column};1R`;
    case 'device-status':
      return `${CSI}0n`;
    case 'primary-device-attributes':
      return `${CSI}?1;2c`;
  }
}

export function createTerminalDeviceQueryController() {
  let pendingQuery = '';

  return {
    /**
     * Strips answerable queries from a PTY chunk, split at each query boundary.
     * Concatenating every `output` gives what the rest of the pipeline (model,
     * replay buffer, browser) should see; each non-null `query` still needs a
     * reply written back to the PTY, after its own segment has been applied.
     */
    consumeOutput(data: string): TerminalDeviceQuerySegment[] {
      const input = pendingQuery + data;
      pendingQuery = '';
      const segments: TerminalDeviceQuerySegment[] = [];
      let output = '';
      let offset = 0;

      while (offset < input.length) {
        const candidate = input.indexOf('\x1b', offset);
        if (candidate === -1) {
          output += input.slice(offset);
          break;
        }
        output += input.slice(offset, candidate);

        const parsed = parseCsiSequence(input, candidate);
        if (parsed.kind === 'partial') {
          const fragment = input.slice(candidate);
          // Only hold a fragment that can still become a query we answer.
          // Buffering every split CSI would move chunk boundaries for the rest
          // of the pipeline, and the resize transaction reassembles its own
          // split sequences (ED3) off those boundaries.
          if (fragment.length <= MAX_PENDING_QUERY_CHARS && isQueryPrefix(fragment)) {
            pendingQuery = fragment;
          } else {
            output += fragment;
          }
          break;
        }
        if (parsed.kind === 'none') {
          output += input[candidate];
          offset = candidate + 1;
          continue;
        }

        const query = QUERY_BY_SEQUENCE.get(parsed.sequence);
        if (query) {
          segments.push({ output, query });
          output = '';
        } else {
          output += parsed.sequence;
        }
        offset = candidate + parsed.sequence.length;
      }

      segments.push({ output, query: null });
      return segments;
    },

    /** Releases a half-received sequence so an exiting PTY loses no output. */
    drain(): string {
      const output = pendingQuery;
      pendingQuery = '';
      return output;
    },
  };
}

function isQueryPrefix(fragment: string): boolean {
  for (const sequence of QUERY_BY_SEQUENCE.keys()) {
    if (sequence.startsWith(fragment)) return true;
  }
  return false;
}

function parseCsiSequence(data: string, offset: number): CsiParseResult {
  if (offset + 1 >= data.length) return { kind: 'partial' };
  if (data[offset + 1] !== '[') return { kind: 'none' };

  for (let index = offset + 2; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    // Final byte terminates the sequence.
    if (code >= 0x40 && code <= 0x7e) {
      return { kind: 'match', sequence: data.slice(offset, index + 1) };
    }
    // Anything outside parameter/intermediate range means this was never a CSI.
    if (code < 0x20 || code > 0x3f) return { kind: 'none' };
  }

  return { kind: 'partial' };
}
