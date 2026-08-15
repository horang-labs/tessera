import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRenderedViewMode } from '@/lib/viewport/rendered-view-mode';

// What is on screen, as opposed to what is stored. Everything that routes a tap
// somewhere — a toast, a notification, a file open — has to ask this and not the
// store, or it sends the tap to a surface a phone is not rendering.
test('a phone renders the list whatever is stored', () => {
  assert.equal(resolveRenderedViewMode('board', true), 'list');
  assert.equal(resolveRenderedViewMode('list', true), 'list');
});

test('anything wider renders what is stored', () => {
  assert.equal(resolveRenderedViewMode('board', false), 'board');
  assert.equal(resolveRenderedViewMode('list', false), 'list');
});
