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

test('opening a session from another tab replaces the inactive session preview', () => {
  const previewTabId = 'session-preview-tab';
  const previewPanelId = 'session-preview-panel';
  const archiveTabId = 'archive-tab';
  const archivePanelId = 'archive-panel';

  useTabStore.setState({
    tabs: [
      { id: previewTabId, projectDir: null, title: null, isPreview: true },
      { id: archiveTabId, projectDir: null, title: 'Archive', isPreview: false },
    ],
    activeTabId: archiveTabId,
    lruTabIds: [archiveTabId, previewTabId],
  });
  usePanelStore.setState({
    tabPanels: {
      [previewTabId]: {
        layout: { type: 'leaf', panelId: previewPanelId },
        panels: {
          [previewPanelId]: { id: previewPanelId, sessionId: 'session-a' },
        },
        activePanelId: previewPanelId,
      },
      [archiveTabId]: {
        layout: { type: 'leaf', panelId: archivePanelId },
        panels: {
          [archivePanelId]: { id: archivePanelId, sessionId: 'archive-dashboard' },
        },
        activePanelId: archivePanelId,
      },
    },
    activeTabId: archiveTabId,
  });

  useTabStore.getState().openPreview('session-b');

  assert.equal(useTabStore.getState().activeTabId, previewTabId);
  assert.equal(usePanelStore.getState().activeTabId, previewTabId);
  assert.equal(
    usePanelStore.getState().tabPanels[previewTabId]?.panels[previewPanelId]?.sessionId,
    'session-b',
  );
});
