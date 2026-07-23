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
  const replayCase = clientMessageHandlersSource.match(
    /case 'replay_events':[\s\S]*?return \{ wasReconnect \};/,
  )?.[0] ?? '';
  assert.match(replayCase, /shouldStartTurnFromReplayEvents\(sessionStore, msg\.sessionId, msg\.events\)/);
});

test('session status dot keeps GUI unread priority with a PTY processing exception', () => {
  const processingPolicy = workItemPrimitivesSource.indexOf('const showsProcessing');
  const unreadBranch = workItemPrimitivesSource.indexOf('if (hasUnread)');

  assert.notEqual(processingPolicy, -1);
  assert.notEqual(unreadBranch, -1);
  assert.match(
    workItemPrimitivesSource,
    /showsProcessing = isProcessing && \(sessionKind === 'terminal' \|\| !hasUnread\)/,
  );
  assert.ok(processingPolicy < unreadBranch, 'status priority must be resolved before rendering unread');
});

test('kanban stripes keep GUI unread priority while PTY processing takes precedence', () => {
  const chatUnreadBranch = kanbanCardSource.indexOf(': visibleUnread\n      ?');
  const chatProcessingBranch = kanbanCardSource.indexOf(': isProcessing\n        ?');
  const taskUnreadBranch = kanbanCardSource.indexOf(': visibleTaskUnread\n      ?');
  const taskProcessingBranch = kanbanCardSource.indexOf(': hasProcessingSession\n        ?');

  assert.notEqual(chatUnreadBranch, -1);
  assert.notEqual(chatProcessingBranch, -1);
  assert.notEqual(taskUnreadBranch, -1);
  assert.notEqual(taskProcessingBranch, -1);
  assert.match(
    kanbanCardSource,
    /visibleUnread = session\.kind === 'terminal' && isProcessing \? false : hasUnread/,
  );
  assert.match(
    kanbanCardSource,
    /visibleTaskUnread = hasTerminalProcessingSession\s*\?\s*false\s*:\s*hasVisibleTaskUnread/,
  );
  assert.ok(chatUnreadBranch < chatProcessingBranch, 'chat card unread stripe must precede processing stripe');
  assert.ok(taskUnreadBranch < taskProcessingBranch, 'task card unread stripe must precede processing stripe');
});
