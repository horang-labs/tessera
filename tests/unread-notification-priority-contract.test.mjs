import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const clientMessageHandlersSource = fs.readFileSync(
  new URL('../src/lib/ws/client-message-handlers.ts', import.meta.url),
  'utf8',
);
const workItemPrimitivesSource = fs.readFileSync(
  new URL('../src/components/chat/work-item-primitives.tsx', import.meta.url),
  'utf8',
);
const kanbanCardSource = fs.readFileSync(
  new URL('../src/components/board/kanban-card.tsx', import.meta.url),
  'utf8',
);

test('late replay events do not restart unread completed sessions', () => {
  assert.match(clientMessageHandlersSource, /function shouldStartTurnFromReplayEvents/);
  assert.match(clientMessageHandlersSource, /if \(\(session\?\.unreadCount \?\? 0\) > 0\) \{\s*return false;\s*\}/);
  assert.match(clientMessageHandlersSource, /case 'replay_events':\s*if \(shouldStartTurnFromReplayEvents\(sessionStore, msg\.sessionId, msg\.events\)\)/);
});

test('session status dot renders unread before processing', () => {
  const unreadBranch = workItemPrimitivesSource.indexOf('if (hasUnread)');
  const processingBranch = workItemPrimitivesSource.indexOf('if (isProcessing)');

  assert.notEqual(unreadBranch, -1);
  assert.notEqual(processingBranch, -1);
  assert.ok(unreadBranch < processingBranch, 'hasUnread must be checked before isProcessing');
});

test('kanban stripes render unread before processing', () => {
  const chatUnreadBranch = kanbanCardSource.indexOf(': hasUnread\n      ?');
  const chatProcessingBranch = kanbanCardSource.indexOf(': isProcessing\n        ?');
  const taskUnreadBranch = kanbanCardSource.indexOf(': hasUnreadSession\n      ?');
  const taskProcessingBranch = kanbanCardSource.indexOf(': hasProcessingSession\n        ?');

  assert.notEqual(chatUnreadBranch, -1);
  assert.notEqual(chatProcessingBranch, -1);
  assert.notEqual(taskUnreadBranch, -1);
  assert.notEqual(taskProcessingBranch, -1);
  assert.ok(chatUnreadBranch < chatProcessingBranch, 'chat card unread stripe must precede processing stripe');
  assert.ok(taskUnreadBranch < taskProcessingBranch, 'task card unread stripe must precede processing stripe');
});
