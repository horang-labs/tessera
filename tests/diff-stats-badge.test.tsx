import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffStatsBadge } from '../src/components/chat/diff-stats-badge';

test('an incomplete addition total is visibly marked as a lower bound', () => {
  const html = renderToStaticMarkup(
    <DiffStatsBadge
      stats={{
        added: 286,
        addedLinesIncomplete: true,
        removed: 102,
        changedFiles: 1911,
        newFiles: 1904,
        deletedFiles: 0,
        computedAt: '2026-09-15T00:00:00.000Z',
      }}
    />,
  );

  assert.match(html, />\+286…</);
  assert.match(html, /\+286 or more/);
  assert.match(html, /Some untracked files were not opened for line counting/);
});
