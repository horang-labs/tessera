import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';

import { DetailedSessionLocationIdentity } from '@/components/panel/empty-panel-state';

const location = {
  projectName: 'content-lab',
  branch: 'main',
  path: '/home/work/Source/content-lab',
};

test('New Session form exposes the exact read-only session location', () => {
  const markup = renderToStaticMarkup(createElement(DetailedSessionLocationIdentity, location));

  assert.match(markup, /data-testid="empty-panel-session-location"/);
  assert.match(markup, /content-lab/);
  assert.match(markup, /main/);
  assert.match(markup, /\/home\/work\/Source\/content-lab/);
});
