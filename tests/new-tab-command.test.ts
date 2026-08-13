import assert from 'node:assert/strict';
import test from 'node:test';

import { openSingletonNewTab } from '@/lib/tab/open-singleton-new-tab';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';

test('the shared New Tab command reuses the active pristine tab', () => {
  useTabStore.setState({
    tabs: [{ id: 'empty-tab', projectDir: null, title: null, isPreview: false }],
    activeTabId: 'empty-tab',
    lruTabIds: ['empty-tab'],
    currentProjectDir: null,
  });
  usePanelStore.setState({
    activeTabId: 'empty-tab',
    tabPanels: {
      'empty-tab': {
        layout: { type: 'leaf', panelId: 'empty-panel' },
        panels: { 'empty-panel': { id: 'empty-panel', sessionId: null } },
        activePanelId: 'empty-panel',
      },
    },
  });
  useWorkspacePeekStore.getState().openWorktree('worktree-1', 'project-1');

  assert.equal(openSingletonNewTab(), 'empty-tab');
  assert.equal(openSingletonNewTab(), 'empty-tab');
  assert.equal(useTabStore.getState().tabs.length, 1);
  assert.equal(useWorkspacePeekStore.getState().target, null);
});
