import assert from 'node:assert/strict';
import test from 'node:test';

import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import type { Tab } from '@/types/tab';
import type { TabPanelData } from '@/types/panel';

function setVisibleTabs(
  tabs: Tab[],
  tabPanels: Record<string, TabPanelData>,
  activeTabId: string,
): void {
  useTabStore.setState({
    tabs,
    activeTabId,
    lruTabIds: [activeTabId, ...tabs.map((tab) => tab.id).filter((id) => id !== activeTabId)],
    projectTabStates: {},
    globalTabState: null,
    currentProjectDir: null,
  });
  usePanelStore.setState({ tabPanels, activeTabId });
}

function leafTabData(panelId: string, sessionId: string | null): TabPanelData {
  return {
    layout: { type: 'leaf', panelId },
    panels: { [panelId]: { id: panelId, sessionId } },
    activePanelId: panelId,
  };
}

test('repeated New Tab commands keep one pristine empty tab', () => {
  const emptyTab: Tab = {
    id: 'empty-tab',
    projectDir: null,
    title: null,
    isPreview: false,
  };
  setVisibleTabs(
    [emptyTab],
    { [emptyTab.id]: leafTabData('empty-panel', null) },
    emptyTab.id,
  );

  const firstId = useTabStore.getState().openNewTab();
  const secondId = useTabStore.getState().openNewTab();

  assert.equal(firstId, emptyTab.id);
  assert.equal(secondId, emptyTab.id);
  assert.equal(useTabStore.getState().tabs.length, 1);
});

test('New Tab activates an existing pristine empty tab instead of adding another', () => {
  const occupiedTab: Tab = {
    id: 'occupied-tab',
    projectDir: '/workspace',
    title: null,
    isPreview: false,
  };
  const emptyTab: Tab = {
    id: 'existing-empty-tab',
    projectDir: '/workspace',
    title: null,
    isPreview: true,
  };
  setVisibleTabs(
    [occupiedTab, emptyTab],
    {
      [occupiedTab.id]: leafTabData('occupied-panel', 'session-1'),
      [emptyTab.id]: leafTabData('empty-panel', null),
    },
    occupiedTab.id,
  );

  const openedTabId = useTabStore.getState().openNewTab();

  assert.equal(openedTabId, emptyTab.id);
  assert.equal(useTabStore.getState().activeTabId, emptyTab.id);
  assert.equal(usePanelStore.getState().activeTabId, emptyTab.id);
  assert.equal(useTabStore.getState().tabs.length, 2);
  assert.equal(
    useTabStore.getState().tabs.find((tab) => tab.id === emptyTab.id)?.isPreview,
    false,
  );
});

test('New Tab collapses previously accumulated pristine empty tabs', () => {
  const firstEmptyTab: Tab = {
    id: 'first-empty-tab',
    projectDir: null,
    title: null,
    isPreview: false,
  };
  const activeEmptyTab: Tab = {
    id: 'active-empty-tab',
    projectDir: null,
    title: null,
    isPreview: false,
  };
  setVisibleTabs(
    [firstEmptyTab, activeEmptyTab],
    {
      [firstEmptyTab.id]: leafTabData('first-empty-panel', null),
      [activeEmptyTab.id]: leafTabData('active-empty-panel', null),
    },
    activeEmptyTab.id,
  );

  const openedTabId = useTabStore.getState().openNewTab();

  assert.equal(openedTabId, activeEmptyTab.id);
  assert.deepEqual(useTabStore.getState().tabs.map((tab) => tab.id), [activeEmptyTab.id]);
  assert.equal(usePanelStore.getState().tabPanels[firstEmptyTab.id], undefined);
});

test('New Tab preserves an empty-looking tab with a custom title', () => {
  const namedTab: Tab = {
    id: 'named-empty-tab',
    projectDir: null,
    title: 'Scratch layout',
    isPreview: false,
  };
  setVisibleTabs(
    [namedTab],
    { [namedTab.id]: leafTabData('named-panel', null) },
    namedTab.id,
  );

  const openedTabId = useTabStore.getState().openNewTab();

  assert.notEqual(openedTabId, namedTab.id);
  assert.equal(useTabStore.getState().tabs.length, 2);
  assert.equal(useTabStore.getState().tabs[0]?.title, 'Scratch layout');
});

test('New Tab preserves an empty split layout', () => {
  const splitTab: Tab = {
    id: 'split-tab',
    projectDir: null,
    title: null,
    isPreview: false,
  };
  setVisibleTabs(
    [splitTab],
    {
      [splitTab.id]: {
        layout: {
          type: 'hsplit',
          children: [
            { type: 'leaf', panelId: 'left-panel' },
            { type: 'leaf', panelId: 'right-panel' },
          ],
          ratio: 0.5,
        },
        panels: {
          'left-panel': { id: 'left-panel', sessionId: null },
          'right-panel': { id: 'right-panel', sessionId: null },
        },
        activePanelId: 'left-panel',
      },
    },
    splitTab.id,
  );

  const openedTabId = useTabStore.getState().openNewTab();

  assert.notEqual(openedTabId, splitTab.id);
  assert.equal(useTabStore.getState().tabs.length, 2);
  assert.equal(usePanelStore.getState().tabPanels[splitTab.id]?.layout.type, 'hsplit');
});

test('New Tab preserves a standalone terminal without a session', () => {
  const terminalTab: Tab = {
    id: 'terminal-tab',
    projectDir: '/workspace',
    title: null,
    isPreview: false,
  };
  const terminalPanelData = leafTabData('terminal-panel', null);
  terminalPanelData.panels['terminal-panel'].terminalId = 'terminal-1';
  setVisibleTabs(
    [terminalTab],
    { [terminalTab.id]: terminalPanelData },
    terminalTab.id,
  );

  const openedTabId = useTabStore.getState().openNewTab();

  assert.notEqual(openedTabId, terminalTab.id);
  assert.equal(useTabStore.getState().tabs.length, 2);
  assert.equal(
    usePanelStore.getState().tabPanels[terminalTab.id]?.panels['terminal-panel']?.terminalId,
    'terminal-1',
  );
});
