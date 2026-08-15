import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskPreparationBadge } from '@/components/task/task-preparation-view';

test('a failed preparation badge explains where to inspect the failure on hover', () => {
  const markup = renderToStaticMarkup(createElement(TaskPreparationBadge, {
    status: 'failed',
    presentation: 'icon',
  }));

  assert.match(
    markup,
    /title="The worktree preparation script failed\. Click to inspect the error in Scripts\."/,
  );
  assert.match(markup, /aria-label="Preparation failed"/);
});
