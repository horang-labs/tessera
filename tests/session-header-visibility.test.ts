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
