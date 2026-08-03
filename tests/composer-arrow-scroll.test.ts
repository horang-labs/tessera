import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveComposerArrowScroll } from '@/lib/chat/composer-arrow-scroll';

const key = (name: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

test('empty or single-line input scrolls in both directions', () => {
  assert.equal(resolveComposerArrowScroll(key('ArrowUp'), '', 0), 'scroll-up');
  assert.equal(resolveComposerArrowScroll(key('ArrowDown'), '', 0), 'scroll-down');
  assert.equal(resolveComposerArrowScroll(key('ArrowUp'), 'hello', 3), 'scroll-up');
  assert.equal(resolveComposerArrowScroll(key('ArrowDown'), 'hello', 3), 'scroll-down');
});

test('multi-line input scrolls only from the edge line', () => {
  const text = 'one\ntwo\nthree';
  // caret on the first line
  assert.equal(resolveComposerArrowScroll(key('ArrowUp'), text, 1), 'scroll-up');
  assert.equal(resolveComposerArrowScroll(key('ArrowDown'), text, 1), 'ignore');
  // caret on the middle line — the caret still has room to move inside the textarea
  assert.equal(resolveComposerArrowScroll(key('ArrowUp'), text, 5), 'ignore');
  assert.equal(resolveComposerArrowScroll(key('ArrowDown'), text, 5), 'ignore');
  // caret on the last line
  assert.equal(resolveComposerArrowScroll(key('ArrowDown'), text, 10), 'scroll-down');
  assert.equal(resolveComposerArrowScroll(key('ArrowUp'), text, 10), 'ignore');
});

test('modified arrows are left to their own handlers', () => {
  assert.equal(resolveComposerArrowScroll(key('ArrowUp', { shiftKey: true }), '', 0), 'ignore');
  assert.equal(resolveComposerArrowScroll(key('ArrowUp', { ctrlKey: true }), '', 0), 'ignore');
  assert.equal(resolveComposerArrowScroll(key('ArrowDown', { metaKey: true }), '', 0), 'ignore');
});

test('non-arrow keys are ignored', () => {
  assert.equal(resolveComposerArrowScroll(key('Enter'), '', 0), 'ignore');
  assert.equal(resolveComposerArrowScroll(key('ArrowLeft'), '', 0), 'ignore');
});
