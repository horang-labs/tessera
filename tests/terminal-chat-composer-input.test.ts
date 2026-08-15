import assert from 'node:assert/strict';
import test from 'node:test';

import {
  insertTerminalChatPathsAtCursor,
} from '@/lib/terminal/terminal-chat-composer-input';

test('terminal chat inserts escaped dropped paths at the current caret', () => {
  assert.deepEqual(
    insertTerminalChatPathsAtCursor('open  now', 5, [
      '/tmp/one file.txt',
      '/tmp/two.txt',
    ]),
    {
      nextValue: "open '/tmp/one file.txt' /tmp/two.txt  now",
      nextCursorPos: 38,
    },
  );
});

test('terminal chat rejects unsafe dropped paths without disturbing the draft', () => {
  assert.deepEqual(
    insertTerminalChatPathsAtCursor('keep', 2, ['bad\npath']),
    { nextValue: 'keep', nextCursorPos: 2 },
  );
});
