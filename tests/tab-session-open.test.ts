import assert from 'node:assert/strict';
import test from 'node:test';

import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

test('opening a session reuses the selected empty New Tab', () => {
  const tabId = 'empty-tab';
  const panelId = 'empty-panel';

  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: null, title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: null } },
        activePanelId: panelId,
      },
    },
    activeTabId: tabId,
  });

  useTabStore.getState().createTabWithSession('session-1');

  assert.equal(useTabStore.getState().tabs.length, 1);
  assert.equal(useTabStore.getState().activeTabId, tabId);
  assert.equal(
    usePanelStore.getState().tabPanels[tabId]?.panels[panelId]?.sessionId,
    'session-1',
  );
});

test('opening a session preserves an occupied selected tab', () => {
  const tabId = 'occupied-tab';
  const panelId = 'occupied-panel';

  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: null, title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: 'session-1' } },
        activePanelId: panelId,
      },
    },
    activeTabId: tabId,
  });

  useTabStore.getState().createTabWithSession('session-2');

  assert.equal(useTabStore.getState().tabs.length, 2);
  assert.equal(
    usePanelStore.getState().tabPanels[tabId]?.panels[panelId]?.sessionId,
    'session-1',
  );
  const activeTabId = useTabStore.getState().activeTabId;
  const activeTabData = usePanelStore.getState().tabPanels[activeTabId];
  assert.equal(
    activeTabData?.panels[activeTabData.activePanelId]?.sessionId,
    'session-2',
  );
});
