import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderEnhancedContent } from '@/components/chat/message-bubble-content';
import {
  failPendingTerminalChatMessage,
  mergeTerminalChatOptimisticMessages,
  reconcilePendingTerminalChatMessages,
  registerPendingTerminalChatMessage,
} from '@/lib/chat/terminal-chat-live-refresh';
import { useChatStore } from '@/stores/chat-store';
import type { EnhancedMessage } from '@/types/chat';

function userMessage(id: string, content: string, timestamp: string): EnhancedMessage {
  return { id, type: 'text', role: 'user', content, timestamp };
}

test('a newer canonical prompt ending with the optimistic send confirms that pending message', () => {
  const pending = userMessage(
    'terminal-chat-pending-1',
    '힙스필드의 Angles 2.0 이건 왜 추천안해주냐',
    '2026-08-09T05:32:06.579Z',
  );
  const canonical = userMessage(
    'hist-user-96',
    `Angles 2.0${pending.content}`,
    '2026-08-09T05:32:07.498Z',
  );

  assert.deepEqual(reconcilePendingTerminalChatMessages([pending], [canonical]), []);
});

test('an exact newer canonical prompt still confirms the optimistic send', () => {
  const pending = userMessage('terminal-chat-pending-exact', 'exact text', '2026-08-09T05:32:06.000Z');
  const canonical = userMessage('hist-user-exact', 'exact text', '2026-08-09T05:32:07.000Z');

  assert.deepEqual(reconcilePendingTerminalChatMessages([pending], [canonical]), []);
});

test('an older transcript message with the same suffix cannot confirm a new pending send', () => {
  const pending = userMessage('terminal-chat-pending-2', 'repeat me', '2026-08-09T05:32:06.579Z');
  const oldCanonical = userMessage('hist-user-1', 'draft repeat me', '2026-08-09T05:31:00.000Z');

  assert.deepEqual(
    reconcilePendingTerminalChatMessages([pending], [oldCanonical]),
    [pending],
  );
});

test('one canonical user turn confirms at most one pending send', () => {
  const first = userMessage('terminal-chat-pending-3', 'same', '2026-08-09T05:32:06.000Z');
  const second = userMessage('terminal-chat-pending-4', 'same', '2026-08-09T05:32:06.100Z');
  const canonical = userMessage('hist-user-2', 'draft same', '2026-08-09T05:32:07.000Z');

  assert.deepEqual(
    reconcilePendingTerminalChatMessages([first, second], [canonical]),
    [second],
  );
});

test('an undelivered optimistic terminal message becomes visibly failed', () => {
  const sessionId = 'terminal-chat-undelivered';
  useChatStore.getState().clearSessionMessages(sessionId);

  const messageId = registerPendingTerminalChatMessage(sessionId, 'not accepted');
  assert.equal(failPendingTerminalChatMessage(sessionId, messageId), true);

  const [message] = useChatStore.getState().messages.get(sessionId) ?? [];
  assert.equal(message?.type, 'text');
  assert.equal(
    message?.type === 'text' ? message.deliveryStatus : undefined,
    'failed',
  );
  const markup = renderToStaticMarkup(createElement(
    () => message ? renderEnhancedContent(message, undefined, () => undefined) : null,
  ));
  assert.match(markup, /data-testid="terminal-message-delivery-failed"/);
  assert.doesNotMatch(markup, /forkFromMessage|fork-from-message|From here/);

  const refreshed = mergeTerminalChatOptimisticMessages(sessionId, []);
  assert.equal(refreshed.length, 1);
  assert.equal(
    refreshed[0]?.type === 'text' ? refreshed[0].deliveryStatus : undefined,
    'failed',
  );
  useChatStore.getState().clearSessionMessages(sessionId);
});

test('optimistic terminal message ids are collision-safe', () => {
  const sessionId = 'terminal-chat-id-collision';
  const first = registerPendingTerminalChatMessage(sessionId, 'first');
  const second = registerPendingTerminalChatMessage(sessionId, 'second');

  assert.notEqual(first, second);
  useChatStore.getState().clearSessionMessages(sessionId);
});
