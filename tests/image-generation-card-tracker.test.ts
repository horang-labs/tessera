import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageGenerationCardTracker } from '../src/lib/image-generation/card-tracker';

test('initial cached and incrementally hydrated historical cards are not new activity', () => {
  const observe = createImageGenerationCardTracker();
  assert.equal(observe([{ id: 'cached' }], false), 0);
  assert.equal(observe([{ id: 'cached' }, { id: 'history-page-1' }], false), 0);
  assert.equal(observe([{ id: 'history-page-2' }], true), 0);
  assert.equal(observe([{ id: 'cached' }, { id: 'history-page-1' }, { id: 'history-page-2' }], true), 0);
});

test('new cards count once, including the first generation after an empty baseline', () => {
  const observe = createImageGenerationCardTracker();
  assert.equal(observe([], true), 0);
  const card = { id: 'new', status: 'running' };
  assert.equal(observe([card], true), 1);
  card.status = 'completed';
  assert.equal(observe([card], true), 0);
  assert.equal(observe([], true), 0);
  assert.equal(observe([{ id: 'new' }, { id: 'second' }, { id: 'third' }, { id: 'third' }], false), 2);
});

test('reopening a panel establishes a new baseline instead of replaying creation events', () => {
  const observe = createImageGenerationCardTracker();
  observe([], true);
  assert.equal(observe([{ id: 'existing' }], true), 1);
  const reopened = createImageGenerationCardTracker();
  assert.equal(reopened([{ id: 'existing' }], true), 0);
  assert.equal(reopened([{ id: 'existing' }, { id: 'new' }], true), 1);
});
