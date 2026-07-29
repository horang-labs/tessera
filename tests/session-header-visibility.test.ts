import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldShowSessionHeader } from '@/lib/terminal/session-header-visibility';

test('GUI sessions keep the header regardless of panel count', () => {
  assert.equal(
    shouldShowSessionHeader({ isTerminalSession: false, isSinglePanel: true }),
    true,
  );
  assert.equal(
    shouldShowSessionHeader({ isTerminalSession: false, isSinglePanel: false }),
    true,
  );
});

test('only a single-panel PTY session hides the redundant header', () => {
  assert.equal(
    shouldShowSessionHeader({ isTerminalSession: true, isSinglePanel: true }),
    false,
  );
  assert.equal(
    shouldShowSessionHeader({ isTerminalSession: true, isSinglePanel: false }),
    true,
  );
});

test('a PTY session with a chat-view toggle keeps its header even alone', () => {
  // The toggle lives in the header; hiding it would strand the session in
  // whichever view it is currently showing.
  assert.equal(
    shouldShowSessionHeader({
      isTerminalSession: true,
      isSinglePanel: true,
      canToggleTerminalChatView: true,
    }),
    true,
  );
});

test('a PTY session without the toggle keeps the old hide behaviour', () => {
  assert.equal(
    shouldShowSessionHeader({
      isTerminalSession: true,
      isSinglePanel: true,
      canToggleTerminalChatView: false,
    }),
    false,
  );
});
