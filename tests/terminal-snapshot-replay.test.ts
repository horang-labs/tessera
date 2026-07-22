import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancePartialEscapeTail,
  extractPartialEscapeTail,
} from '../src/lib/terminal/terminal-partial-escape-tail';
import { buildTerminalSnapshotReplay } from '../src/lib/terminal/terminal-snapshot-replay';

test('partial escape tracking folds safely across PTY chunk boundaries', () => {
  assert.equal(extractPartialEscapeTail('plain\x1b[31'), '\x1b[31');
  assert.equal(advancePartialEscapeTail('\x1b[31', 'mred'), '');
  assert.equal(advancePartialEscapeTail('', '\x1b]8;;https://example.com'), '\x1b]8;;https://example.com');
  assert.equal(advancePartialEscapeTail('\x1b]8;;https://example.com', '\x1b\\link'), '');
});

test('normal snapshot replay exits alt screen and clears the old grid first', () => {
  const replay = buildTerminalSnapshotReplay({ data: 'snapshot' });
  assert.equal(replay, '\x1b[?1049l\x1b[2J\x1b[3J\x1b[Hsnapshot');
});

test('alternate snapshot replay rebuilds normal scrollback before the active frame', () => {
  const replay = buildTerminalSnapshotReplay({
    data: 'alt-frame',
    alternateScreen: true,
    scrollbackAnsi: 'normal-scrollback',
    pendingEscapeTailAnsi: '\x1b[38;2',
  });

  assert.ok(replay.indexOf('normal-scrollback') < replay.indexOf('\x1b[?1049h'));
  assert.ok(replay.indexOf('\x1b[?1049h') < replay.indexOf('alt-frame'));
  assert.ok(replay.endsWith('\x1b[38;2'), 'the incomplete parser tail must be the final bytes');
});
