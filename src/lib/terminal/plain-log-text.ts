/**
 * Turn what a terminal printed into something readable outside one.
 *
 * A stored run's output is the bytes its PTY emitted, escape sequences and
 * all. Rendered into a `<pre>` those show up as the `[1G[0K` litter that a
 * progress spinner leaves behind, so anything displaying a log without a
 * terminal has to flatten it first.
 *
 * This is a reading, not an emulation: it keeps what was printed and drops
 * what only told the cursor where to go. The one piece of cursor behaviour it
 * does honour is rewriting — a line printed over itself shows only what it
 * ended up saying, because that is what the user saw.
 */

/**
 * A move to column 1, or an erase-in-line. Both mean the same thing here: what
 * follows is written over what came before it on that line.
 */
const REWRITES_THE_LINE = /\u001b\[(?:[01]?G|[012]?K)/g;

/** `ESC ] … BEL` or `ESC ] … ESC \` — titles, hyperlinks, and the like. */
const OPERATING_SYSTEM_COMMAND = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** `ESC [ … final-byte`, the ordinary control sequences, private modes included. */
const CONTROL_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Anything else introduced by ESC, which is a sequence this does not model. */
const OTHER_ESCAPE = /\u001b[@-Z\\-_]?/g;

/** What is left of the C0 set once tab and newline are spoken for. */
const STRAY_CONTROL = /[\u0001-\u0008\u000b-\u001f]/g;

/**
 * Stands in for "start writing this line again".
 *
 * A separate mark rather than a carriage return, because CRLF has to stay
 * readable as a line ending: `a\r\nb` is two lines, not a line `a` written
 * over by nothing.
 */
const REWRITE_MARK = '\u0000';

export function toPlainLogText(raw: string): string {
  const marked = raw
    .replace(OPERATING_SYSTEM_COMMAND, '')
    // Before the general sequence rule, which would otherwise take these two
    // along with everything else and lose the rewrite they stand for.
    .replace(REWRITES_THE_LINE, REWRITE_MARK)
    .replace(CONTROL_SEQUENCE, '')
    .replace(OTHER_ESCAPE, '')
    // Line endings first, so the carriage returns left over are the ones that
    // really did write over something.
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, REWRITE_MARK);

  const lines = marked
    .split('\n')
    .map((line) => lastWriteOf(line).replace(STRAY_CONTROL, ''));

  // A spinner clears its line before the newline, leaving an empty one behind;
  // several in a row would otherwise open a hole in the middle of the log.
  // Leading and trailing blank lines go, but indentation is what was printed.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/**
 * What a line says once every rewrite of it has happened.
 *
 * The last thing written wins, except when it wrote nothing — clearing a line
 * and printing nothing more leaves it empty, which is exactly what a finished
 * spinner does.
 */
function lastWriteOf(line: string): string {
  const writes = line.split(REWRITE_MARK);
  return writes[writes.length - 1];
}
