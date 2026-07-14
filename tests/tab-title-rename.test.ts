import assert from 'node:assert/strict';
import test from 'node:test';

import { useTabStore } from '@/stores/tab-store';

test('a tab can be given a custom title without changing its identity', () => {
  const tab = {
    id: 'rename-me',
    projectDir: '/workspace',
    title: null,
    isPreview: false,
  };

  useTabStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    lruTabIds: [tab.id],
  });

  useTabStore.getState().renameTab(tab.id, 'Release checklist');

  assert.deepEqual(useTabStore.getState().tabs, [
    { ...tab, title: 'Release checklist' },
  ]);
});
