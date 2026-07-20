import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTerminalPreviewSurface } from '@/lib/terminal/terminal-preview-surface-lifecycle';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

const tabId = 'preview-tab';
const panelId = 'preview-panel';
const sessionId = 'preview-session';

function arrangePreview(): void {
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: true }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId } },
        activePanelId: panelId,
      },
    },
  });
}

async function flushAudit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('pinning an LRU-evicted preview retains its runtime and disposes its cold surface', async () => {
  arrangePreview();
  let released = 0;
  let disposed = 0;
  registerTerminalPreviewSurface(sessionId, {
    releasePreviewRuntime: () => { released += 1; },
    disposeIfUnmounted: () => { disposed += 1; },
  });

  useTabStore.getState().pinTab(tabId);
  await flushAudit();

  assert.equal(released, 0);
  assert.equal(disposed, 1);
});

test('replacing an LRU-evicted preview releases the runtime it created', async () => {
  arrangePreview();
  let released = 0;
  registerTerminalPreviewSurface(sessionId, {
    releasePreviewRuntime: () => { released += 1; },
    disposeIfUnmounted: () => {},
  });

  usePanelStore.getState().assignSession(panelId, 'replacement-session');
  await flushAudit();

  assert.equal(released, 1);
});

test('leaving a PTY preview for a retained tab releases its runtime and closes the preview', async () => {
  arrangePreview();
  const retainedTabId = 'retained-tab';
  const retainedPanelId = 'retained-panel';
  useTabStore.setState((state) => ({
    tabs: [
      ...state.tabs,
      { id: retainedTabId, projectDir: '/workspace', title: null, isPreview: false },
    ],
  }));
  usePanelStore.setState((state) => ({
    tabPanels: {
      ...state.tabPanels,
      [retainedTabId]: {
        layout: { type: 'leaf', panelId: retainedPanelId },
        panels: {
          [retainedPanelId]: {
            id: retainedPanelId,
            sessionId: 'retained-session',
          },
        },
        activePanelId: retainedPanelId,
      },
    },
  }));

  let released = 0;
  registerTerminalPreviewSurface(sessionId, {
    releasePreviewRuntime: () => { released += 1; },
    disposeIfUnmounted: () => {},
  });

  useTabStore.getState().setActiveTab(retainedTabId);
  await flushAudit();

  assert.equal(released, 1);
  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), false);
});
