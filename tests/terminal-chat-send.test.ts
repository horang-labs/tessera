import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTerminalChatText,
  sendTerminalChatMessage,
} from '@/lib/terminal/terminal-chat-send';
import { wsClient } from '@/lib/ws/client';

test('CRLF collapses to LF so the TUI does not see a double submit', () => {
  assert.equal(normalizeTerminalChatText('first\r\nsecond'), 'first\nsecond');
  assert.equal(normalizeTerminalChatText('first\rsecond'), 'first\nsecond');
});

test('trailing newlines are stripped', () => {
  // A trailing newline submits the prompt before the delayed Enter is sent,
  // which would fire a second, empty turn.
  assert.equal(normalizeTerminalChatText('done\n'), 'done');
  assert.equal(normalizeTerminalChatText('done\n\n\n'), 'done');
  assert.equal(normalizeTerminalChatText('done\r\n'), 'done');
});

test('interior newlines survive — that is what bracketed paste is for', () => {
  assert.equal(normalizeTerminalChatText('one\n\ntwo'), 'one\n\ntwo');
});

test('leading whitespace is preserved', () => {
  assert.equal(normalizeTerminalChatText('  indented'), '  indented');
});

test('whitespace-only input normalizes to something the caller rejects', () => {
  assert.equal(normalizeTerminalChatText('\n\n').trim(), '');
  assert.equal(normalizeTerminalChatText('   ').trim(), '');
});

test('terminal chat uses the acknowledged session transport with normalized text', async () => {
  const originalSubmit = wsClient.submitTerminalChatInput;
  const calls: Array<{ sessionId: string; text: string }> = [];
  wsClient.submitTerminalChatInput = (sessionId, text) => {
    calls.push({ sessionId, text });
    return { submitted: Promise.resolve(true) };
  };

  try {
    const handle = sendTerminalChatMessage('session-resumed', 'first\r\nsecond\n');
    assert.ok(handle);
    assert.equal(await handle.submitted, true);
    assert.deepEqual(calls, [{
      sessionId: 'session-resumed',
      text: 'first\nsecond',
    }]);
  } finally {
    wsClient.submitTerminalChatInput = originalSubmit;
  }
});
