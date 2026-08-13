import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ViewModeToggle } from '@/components/tab/view-mode-toggle';

test('the selected List or Board mode uses the accent surface for clear contrast', () => {
  const list = renderToStaticMarkup(createElement(ViewModeToggle, {
    viewMode: 'list',
    onToggle: () => undefined,
    labelMode: 'short',
  }));
  assert.match(list, /data-testid="view-mode-list"[^>]*bg-\(--accent\)[^>]*text-white/);
  assert.match(list, /data-testid="view-mode-board"[^>]*text-\(--text-secondary\)/);

  const board = renderToStaticMarkup(createElement(ViewModeToggle, {
    viewMode: 'board',
    onToggle: () => undefined,
    labelMode: 'short',
  }));
  assert.match(board, /data-testid="view-mode-board"[^>]*bg-\(--accent\)[^>]*text-white/);
});
