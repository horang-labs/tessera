import assert from 'node:assert/strict';
import test from 'node:test';
import { getPrioritizedCollectionIndicatorStatus } from '@/lib/chat/collection-status-indicator';

const baseFlags = {
  hasVisibleRuntimeSession: true,
  hasProcessingSession: true,
  hasTerminalProcessingSession: false,
  hasUnreadSession: true,
  hasAwaitingUserSession: false,
};

test('grouped GUI status keeps unread ahead of processing', () => {
  assert.equal(getPrioritizedCollectionIndicatorStatus(baseFlags), 'unread');
});

test('grouped PTY processing outranks stale unread state', () => {
  assert.equal(getPrioritizedCollectionIndicatorStatus({
    ...baseFlags,
    hasTerminalProcessingSession: true,
  }), 'processing');
});
