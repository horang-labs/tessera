import assert from 'node:assert/strict';
import test from 'node:test';

import { SHORTCUT_REGISTRY } from '@/lib/keyboard/registry';

test('adjacent tab navigation commands are not exposed', () => {
  for (const commandId of ['prev-tab', 'next-tab']) {
    assert.equal(commandId in SHORTCUT_REGISTRY, false);
  }
});
