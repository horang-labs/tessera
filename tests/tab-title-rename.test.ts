import assert from 'node:assert/strict';
import test from 'node:test';

import { useTabStore } from '@/stores/tab-store';
import { derivePanelCount, resolveTabTitleCommit } from '@/components/tab/tab-item';

test('panel count includes empty and terminal-only panels', () => {
  assert.equal(derivePanelCount({
    empty: { id: 'empty', sessionId: null },
    terminal: { id: 'terminal', sessionId: null, terminalId: 'terminal-1' },
    session: { id: 'session', sessionId: 'session-1' },
  }), 3);
});

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

test('editing the tab title renames the active session, not just the tab', () => {
  assert.deepEqual(
    resolveTabTitleCommit({
      nextTitle: 'Deploy script',
      displayTitle: 'session-1',
      tabTitle: null,
      renameTargetSessionId: 'session-1',
    }),
    { kind: 'session', sessionId: 'session-1', title: 'Deploy script' },
  );
});

test('a tab without a renameable session falls back to a tab-local title', () => {
  assert.deepEqual(
    resolveTabTitleCommit({
      nextTitle: 'Scratch',
      displayTitle: 'New tab',
      tabTitle: null,
      renameTargetSessionId: null,
    }),
    { kind: 'tab', title: 'Scratch' },
  );
});

test('an empty title clears a tab-local name but never renames a session', () => {
  assert.deepEqual(
    resolveTabTitleCommit({
      nextTitle: '',
      displayTitle: 'Temporary name',
      tabTitle: 'Temporary name',
      renameTargetSessionId: null,
    }),
    { kind: 'tab', title: null },
  );

  assert.deepEqual(
    resolveTabTitleCommit({
      nextTitle: '',
      displayTitle: 'Deploy script',
      tabTitle: null,
      renameTargetSessionId: 'session-1',
    }),
    { kind: 'noop' },
  );
});

test('committing an unchanged title does nothing', () => {
  assert.deepEqual(
    resolveTabTitleCommit({
      nextTitle: 'Deploy script',
      displayTitle: 'Deploy script',
      tabTitle: null,
      renameTargetSessionId: 'session-1',
    }),
    { kind: 'noop' },
  );
});
