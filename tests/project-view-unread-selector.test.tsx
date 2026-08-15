import assert from 'node:assert/strict';
import test from 'node:test';

import { selectProjectViewSessionUnreadState } from '@/hooks/use-project-view-session-unread';

test('the shared visible-surface selector includes notification-only unread state', () => {
  assert.equal(selectProjectViewSessionUnreadState({
    canonicalUnread: false,
    taskSummaryUnread: false,
    notificationUnread: true,
  }), true);
});
