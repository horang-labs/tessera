import assert from 'node:assert/strict';
import test from 'node:test';

import { orderMountedTabIds } from '@/lib/tab/mounted-tab-order';

test('mounted tab DOM order stays aligned with the tab bar when LRU order changes', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  assert.deepEqual(orderMountedTabIds(tabs, ['b', 'a']), ['a', 'b']);
  assert.deepEqual(orderMountedTabIds(tabs, ['a', 'b']), ['a', 'b']);
});

test('mounted tab order still respects LRU membership and eviction', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(orderMountedTabIds(tabs, ['c', 'b']), ['b', 'c']);
});
