import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptySessionReplayState,
  applySessionReplayEvent,
  type SessionReplayState,
} from '../src/lib/session-replay-reducer';
import type { SessionReplayEvent } from '../src/lib/session-replay-types';
import type { TextMessage } from '../src/types/chat';

const SID = 'sess-1';
const TS = '2026-06-24T00:00:00.000Z';

function reduce(events: SessionReplayEvent[]): SessionReplayState {
  let state = createEmptySessionReplayState();
  for (const event of events) {
    state = applySessionReplayEvent(SID, state, event);
  }
  return state;
}

function lastText(state: SessionReplayState): TextMessage {
  const msg = state.messages[state.messages.length - 1];
  assert.equal(msg.type, 'text');
  return msg as TextMessage;
}

test('streamed assistant chunks adopt the stable messageId from the first chunk', () => {
  const state = reduce([
    { v: 1, type: 'assistant_message_chunk', timestamp: TS, content: 'Hel', messageId: 'm1' },
    { v: 1, type: 'assistant_message_chunk', timestamp: TS, content: 'lo', messageId: 'm1' },
  ]);
  const msg = lastText(state);
  assert.equal(msg.id, 'm1');
  assert.equal(msg.content, 'Hello');
  assert.equal(msg.role, 'assistant');
});

test('completed message_translation attaches translatedContent by id (live path)', () => {
  const state = reduce([
    { v: 1, type: 'assistant_message_chunk', timestamp: TS, content: 'Done', messageId: 'm1' },
    {
      v: 1,
      type: 'message_translation',
      timestamp: TS,
      targetMessageId: 'm1',
      content: '완료',
      sourceLang: 'en',
      targetLang: 'ko',
      status: 'completed',
    },
  ]);
  const msg = lastText(state);
  assert.equal(msg.content, 'Done');
  assert.equal(msg.translatedContent, '완료');
  assert.equal(msg.translationStatus, 'completed');
  assert.equal(msg.translationLang, 'ko');
});

test('completed message_translation attaches by id on the reload path (assistant_message event)', () => {
  const state = reduce([
    { v: 1, type: 'assistant_message', timestamp: TS, content: 'Bye', messageId: 'm2' },
    {
      v: 1,
      type: 'message_translation',
      timestamp: TS,
      targetMessageId: 'm2',
      content: '안녕',
      sourceLang: 'en',
      targetLang: 'ko',
      status: 'completed',
    },
  ]);
  const msg = lastText(state);
  assert.equal(msg.id, 'm2');
  assert.equal(msg.translatedContent, '안녕');
});

test('pending and error translation set status without clobbering content', () => {
  const pending = reduce([
    { v: 1, type: 'assistant_message_chunk', timestamp: TS, content: 'Hi', messageId: 'm1' },
    { v: 1, type: 'message_translation', timestamp: TS, targetMessageId: 'm1', sourceLang: 'en', targetLang: 'ko', status: 'pending' },
  ]);
  assert.equal(lastText(pending).translationStatus, 'pending');
  assert.equal(lastText(pending).translatedContent, undefined);
  assert.equal(lastText(pending).content, 'Hi');

  const errored = reduce([
    { v: 1, type: 'assistant_message_chunk', timestamp: TS, content: 'Hi', messageId: 'm1' },
    { v: 1, type: 'message_translation', timestamp: TS, targetMessageId: 'm1', sourceLang: 'en', targetLang: 'ko', status: 'error' },
  ]);
  assert.equal(lastText(errored).translationStatus, 'error');
  assert.equal(lastText(errored).content, 'Hi');
});

test('user_message input translation attaches the sent (translated) text by messageId', () => {
  const state = reduce([
    { v: 1, type: 'user_message', timestamp: TS, content: '안녕', messageId: 'u1' },
    {
      v: 1,
      type: 'message_translation',
      timestamp: TS,
      targetMessageId: 'u1',
      content: 'Hello',
      sourceLang: 'ko',
      targetLang: 'en',
      status: 'completed',
    },
  ]);
  const msg = lastText(state);
  assert.equal(msg.id, 'u1');
  assert.equal(msg.content, '안녕');           // original (what the user typed)
  assert.equal(msg.translatedContent, 'Hello'); // sent to the agent
});

test('a translation targeting an unknown id is a no-op (no throw, no stray message)', () => {
  const state = reduce([
    { v: 1, type: 'assistant_message_chunk', timestamp: TS, content: 'Hi', messageId: 'm1' },
    { v: 1, type: 'message_translation', timestamp: TS, targetMessageId: 'does-not-exist', content: 'x', sourceLang: 'en', targetLang: 'ko', status: 'completed' },
  ]);
  assert.equal(state.messages.length, 1);
  assert.equal(lastText(state).translatedContent, undefined);
});
