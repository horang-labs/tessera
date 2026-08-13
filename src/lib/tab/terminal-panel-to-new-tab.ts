import type { PanelNodeDragPayload } from '@/lib/dnd/panel-session-drag';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

/**
 * Move a standalone terminal leaf into its own tab without changing the
 * terminal runtime identity or its source workspace context.
 */
export function moveTerminalPanelToNewTab(payload: PanelNodeDragPayload): boolean {
  const panelStore = usePanelStore.getState();
  const tabStore = useTabStore.getState();
  const previousActiveTabId = tabStore.activeTabId;
  const sourceTabData = panelStore.tabPanels[payload.tabId];
  const sourcePanel = sourceTabData?.panels[payload.panelId];
  const terminalId = sourcePanel?.terminalId ?? null;
  const terminalSessionId = sourcePanel?.terminalSessionId ?? null;
  const terminalCwd = sourcePanel?.terminalCwd ?? null;
  const sourceProjectDir = tabStore.tabs.find((tab) => tab.id === payload.tabId)?.projectDir ?? null;
  if (!sourceTabData || !terminalId || payload.tabId !== previousActiveTabId) return false;

  if (Object.keys(sourceTabData.panels).length > 1) {
    panelStore.closePanel(payload.panelId);
  } else {
    panelStore.assignTerminal(payload.panelId, null);
  }

  const newTabId = tabStore.createTab(null, { insertAfterTabId: payload.tabId });
  const newTabData = usePanelStore.getState().tabPanels[newTabId];
  const newPanelId = newTabData?.activePanelId;
  if (!newPanelId) return false;
  usePanelStore.getState().assignTerminal(
    newPanelId,
    terminalId,
    terminalSessionId,
    terminalCwd,
  );
  if (sourceProjectDir) {
    useTabStore.getState().setTabProject(newTabId, sourceProjectDir);
  }

  if (previousActiveTabId !== newTabId) {
    useTabStore.getState().setActiveTab(previousActiveTabId);
  }
  return true;
}
