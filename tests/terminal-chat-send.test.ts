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

test('terminal chat delegates one normalized semantic prompt to the server-owned runtime', async () => {
  const originalSubmitTerminalPrompt = wsClient.submitTerminalPrompt;
  const submitted: Array<{ sessionId: string; text: string; submissionId: string }> = [];
  wsClient.submitTerminalPrompt = async (sessionId, text, submissionId) => {
    submitted.push({ sessionId, text, submissionId });
    return { accepted: true };
  };

  try {
    assert.deepEqual(
      await sendTerminalChatMessage('session-a', 'first\r\nsecond\n', 'submission-a'),
      { accepted: true },
    );
    assert.deepEqual(submitted, [{
      sessionId: 'session-a',
      text: 'first\nsecond',
      submissionId: 'submission-a',
    }]);
  } finally {
    wsClient.submitTerminalPrompt = originalSubmitTerminalPrompt;
  }
});
