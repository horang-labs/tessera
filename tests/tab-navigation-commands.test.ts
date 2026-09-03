import assert from 'node:assert/strict';
import test from 'node:test';

import { SHORTCUT_REGISTRY } from '@/lib/keyboard/registry';

test('adjacent tab navigation commands are exposed with desktop-standard shortcuts', () => {
  assert.equal(
    SHORTCUT_REGISTRY['previous-tab'].default,
    '$mod+Alt+Shift+PageUp',
  );
  assert.equal(
    SHORTCUT_REGISTRY['next-tab'].default,
    '$mod+Alt+Shift+PageDown',
  );
});
