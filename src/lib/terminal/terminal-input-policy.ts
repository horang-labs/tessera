export type TerminalKeyboardOwner = 'xterm' | 'input-bar';

export interface SanitizedXtermData {
  data: string;
  droppedMouseReports: number;
}

const SGR_MOUSE_PREFIX = '\x1b[<';
const SGR_MOUSE_BODY = /^\d{1,4};\d{1,4};\d{1,4}$/;

/**
 * Removes complete malformed SGR mouse frames from xterm-generated data.
 *
 * This is deliberately not a general `NaN` filter: ordinary terminal input, parser
 * replies and surrounding bytes pass through byte-for-byte. The phone input bar also
 * bypasses this path, so a user can still submit literal text such as "NaN".
 */
export function sanitizeXtermGeneratedData(data: string): SanitizedXtermData {
  let cursor = 0;
  let output = '';
  let droppedMouseReports = 0;

  while (cursor < data.length) {
    const start = data.indexOf(SGR_MOUSE_PREFIX, cursor);
    if (start === -1) {
      output += data.slice(cursor);
      break;
    }

    output += data.slice(cursor, start);
    let end = start + SGR_MOUSE_PREFIX.length;
    while (end < data.length && data[end] !== 'M' && data[end] !== 'm') end += 1;

    // xterm emits a whole mouse report in one onData callback. Preserve an incomplete
    // prefix rather than guessing where arbitrary terminal data should end.
    if (end === data.length) {
      output += data.slice(start);
      break;
    }

    const body = data.slice(start + SGR_MOUSE_PREFIX.length, end);
    if (SGR_MOUSE_BODY.test(body)) {
      output += data.slice(start, end + 1);
    } else {
      droppedMouseReports += 1;
    }
    cursor = end + 1;
  }

  return { data: output, droppedMouseReports };
}
