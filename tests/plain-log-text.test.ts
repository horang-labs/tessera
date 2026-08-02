import assert from 'node:assert/strict';
import test from 'node:test';
import { toPlainLogText } from '@/lib/terminal/plain-log-text';

test('plain output is left exactly as it was', () => {
  assert.equal(toPlainLogText('added 1 package\nfound 0 vulnerabilities'), 'added 1 package\nfound 0 vulnerabilities');
});

test('colour codes are dropped, and the words they wrapped are kept', () => {
  assert.equal(
    toPlainLogText('found \u001b[32m\u001b[1m0\u001b[22m\u001b[39m vulnerabilities'),
    'found 0 vulnerabilities',
  );
});

test('the dim prefix goes but the traced command stays', () => {
  // What `set -x` writes for each line of a preparation script: the colours are
  // for the live terminal, the command is what a stored log is read for.
  const traced = '\u001b[2m+ \u001b[0mcp /src/.env .\n\u001b[2m+ \u001b[0mnpm install';

  assert.equal(toPlainLogText(traced), '+ cp /src/.env .\n+ npm install');
});

test('a spinner that rewrites its own line leaves only what it settled on', () => {
  // npm draws progress by moving to column 1, clearing, and printing again.
  const spinner = '\u001b[1G\u001b[0K⠙\u001b[1G\u001b[0K⠹\u001b[1G\u001b[0Kdone';

  assert.equal(toPlainLogText(spinner), 'done');
});

test('a line rewritten down to nothing disappears rather than leaving a blank', () => {
  const raw = '\u001b[1G\u001b[0K⠙\u001b[1G\u001b[0K\nadded 1 package\n';

  assert.equal(toPlainLogText(raw), 'added 1 package');
});

test('carriage returns overwrite the same way the cursor move does', () => {
  assert.equal(toPlainLogText('50%\r100%'), '100%');
});

test('cursor moves to a column other than the first are not treated as rewrites', () => {
  // Only column 1 puts the cursor back at the start of what was written.
  assert.equal(toPlainLogText('abc\u001b[5Gdef'), 'abcdef');
});

test('operating system commands, which carry their own terminator, are dropped whole', () => {
  assert.equal(toPlainLogText('\u001b]0;a title\u0007npm install'), 'npm install');
  assert.equal(toPlainLogText('\u001b]8;;http://x\u001b\\link'), 'link');
});

test('alternate screen switches and other bracketed modes leave no trace', () => {
  assert.equal(toPlainLogText('\u001b[?1049hbody\u001b[?1049l'), 'body');
});

test('stray control characters go, but tabs and newlines stay', () => {
  assert.equal(toPlainLogText('a\u0007b\tc\nd'), 'ab\tc\nd');
});

test('runs of blank lines collapse, so a cleared progress area does not become a gap', () => {
  assert.equal(toPlainLogText('a\n\n\n\n\nb'), 'a\n\nb');
});

test('surrounding blank space goes, because the log is shown as a block', () => {
  assert.equal(toPlainLogText('\n\n  npm install\n\n\n'), '  npm install');
});

test('empty input stays empty', () => {
  assert.equal(toPlainLogText(''), '');
  assert.equal(toPlainLogText('\u001b[0m\u001b[1G\u001b[0K'), '');
});
