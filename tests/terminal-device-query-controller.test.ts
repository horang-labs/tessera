import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerminalDeviceQueryController,
  formatTerminalDeviceQueryReply,
  type TerminalDeviceQuerySegment,
} from '@/lib/terminal/terminal-device-query-controller';

function flatten(segments: readonly TerminalDeviceQuerySegment[]) {
  return {
    output: segments.map((segment) => segment.output).join(''),
    queries: segments.map((segment) => segment.query).filter((query) => query !== null),
  };
}

test('device query controller consumes the queries codex emits at startup', () => {
  const controller = createTerminalDeviceQueryController();

  // The exact opening burst codex writes before drawing anything.
  const result = flatten(controller.consumeOutput(
    '\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h\x1b[6n\x1b[?u\x1b[c\x1b[?2026h',
  ));

  // CPR and primary DA are answered here; every other sequence must survive
  // untouched, including the kitty flags query we deliberately do not answer.
  assert.equal(
    result.output,
    '\x1b[?2004h\x1b[>4;0m\x1b[>7u\x1b[?1004h\x1b[?u\x1b[?2026h',
  );
  assert.deepEqual(result.queries, ['cursor-position', 'primary-device-attributes']);
});

test('device query controller splits a chunk at each query boundary', () => {
  const controller = createTerminalDeviceQueryController();

  // The split lets the caller apply `before` to its model, read the cursor for
  // the reply, and only then apply `after` — a cursor report must not describe
  // output that had not been written when the program asked.
  assert.deepEqual(controller.consumeOutput('before\x1b[6nafter'), [
    { output: 'before', query: 'cursor-position' },
    { output: 'after', query: null },
  ]);
});

test('device query controller always returns a trailing segment', () => {
  const controller = createTerminalDeviceQueryController();

  assert.deepEqual(controller.consumeOutput('plain'), [{ output: 'plain', query: null }]);
  assert.deepEqual(controller.consumeOutput('\x1b[6n'), [
    { output: '', query: 'cursor-position' },
    { output: '', query: null },
  ]);
});

test('device query controller answers a cursor report from the live cursor', () => {
  assert.equal(
    formatTerminalDeviceQueryReply('cursor-position', { row: 12, column: 34 }),
    '\x1b[12;34R',
  );
  assert.equal(
    formatTerminalDeviceQueryReply('extended-cursor-position', { row: 3, column: 7 }),
    '\x1b[?3;7;1R',
  );
  assert.equal(
    formatTerminalDeviceQueryReply('device-status', { row: 1, column: 1 }),
    '\x1b[0n',
  );
  // Matches what xterm.js reports, so the terminal identity is the same
  // whether the server or the browser answered.
  assert.equal(
    formatTerminalDeviceQueryReply('primary-device-attributes', { row: 1, column: 1 }),
    '\x1b[?1;2c',
  );
});

test('device query controller clamps a degenerate cursor to the home position', () => {
  assert.equal(
    formatTerminalDeviceQueryReply('cursor-position', { row: 0, column: -4 }),
    '\x1b[1;1R',
  );
});

test('device query controller reassembles a query split across PTY chunks', () => {
  const controller = createTerminalDeviceQueryController();

  const first = flatten(controller.consumeOutput('before\x1b[6'));
  assert.equal(first.output, 'before');
  assert.deepEqual(first.queries, []);

  const second = flatten(controller.consumeOutput('nafter'));
  assert.equal(second.output, 'after');
  assert.deepEqual(second.queries, ['cursor-position']);
});

test('device query controller leaves ordinary output and lookalike CSI intact', () => {
  const controller = createTerminalDeviceQueryController();

  // `6m` is SGR, `?6h` is DECOM, `16n` is not a query we answer, and a bare
  // ESC that never becomes a CSI must still reach the screen.
  const result = flatten(controller.consumeOutput('\x1b[6m\x1b[?6h\x1b[16n\x1bXtext'));

  assert.equal(result.output, '\x1b[6m\x1b[?6h\x1b[16n\x1bXtext');
  assert.deepEqual(result.queries, []);
});

test('device query controller does not hold a split CSI that cannot become a query', () => {
  const controller = createTerminalDeviceQueryController();

  // ED3 arriving as `\x1b[3` + `J` must keep its original chunk boundaries:
  // the resize transaction reassembles that sequence itself, and buffering it
  // here would hide the split half from it.
  const first = flatten(controller.consumeOutput('rows\x1b[3'));
  assert.equal(first.output, 'rows\x1b[3');
  assert.deepEqual(first.queries, []);

  const second = flatten(controller.consumeOutput('J'));
  assert.equal(second.output, 'J');
  assert.deepEqual(second.queries, []);
});

test('device query controller drains a half-received sequence on exit', () => {
  const controller = createTerminalDeviceQueryController();

  assert.equal(flatten(controller.consumeOutput('tail\x1b[')).output, 'tail');
  assert.equal(controller.drain(), '\x1b[');
  assert.equal(controller.drain(), '');
});

test('device query controller flushes an oversized fragment instead of buffering it', () => {
  const controller = createTerminalDeviceQueryController();
  const oversized = `\x1b[${'1;'.repeat(80)}`;

  assert.equal(flatten(controller.consumeOutput(oversized)).output, oversized);
  assert.equal(controller.drain(), '');
});
