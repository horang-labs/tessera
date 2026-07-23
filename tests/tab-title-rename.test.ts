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

test('renaming a preview pins it before it can be reused for unrelated content', () => {
  const tab = {
    id: 'preview-tab',
    projectDir: '/workspace',
    title: null,
    isPreview: true,
  };

  useTabStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    lruTabIds: [tab.id],
  });

  useTabStore.getState().renameTab(tab.id, 'Keep this tab');

  assert.deepEqual(useTabStore.getState().tabs, [
    { ...tab, title: 'Keep this tab', isPreview: false },
  ]);
});

test('clearing a custom title restores derived-title behavior', () => {
  const tab = {
    id: 'custom-tab',
    projectDir: '/workspace',
    title: 'Temporary name',
    isPreview: false,
  };

  useTabStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    lruTabIds: [tab.id],
  });

  useTabStore.getState().renameTab(tab.id, null);

  assert.deepEqual(useTabStore.getState().tabs, [{ ...tab, title: null }]);
});
