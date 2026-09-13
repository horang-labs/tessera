import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneTabHeaderSelection, selectTabHeader } from '@/lib/tab/tab-header-selection';

test('header selection toggles and ranges in visual order without changing the active fallback', () => {
  const ids = ['a', 'b', 'c', 'd'];
  let state = { selectedTabIds: new Set<string>(), anchorTabId: null };
  state = selectTabHeader(state, ids, 'c', 'toggle', 'a');
  assert.deepEqual([...state.selectedTabIds], ['a', 'c']);
  assert.equal(state.anchorTabId, 'c');
  state = selectTabHeader(state, ids, 'a', 'range', 'a');
  assert.deepEqual([...state.selectedTabIds], ['a', 'b', 'c']);
  state = selectTabHeader(state, ids, 'd', 'add-range', 'a');
  assert.deepEqual([...state.selectedTabIds], ['a', 'b', 'c', 'd']);
  assert.deepEqual([...pruneTabHeaderSelection(state, ['b', 'd']).selectedTabIds], ['b', 'd']);
});
