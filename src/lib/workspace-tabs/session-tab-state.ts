import type { Tab } from '@/types/tab';
import type { TabPanelData } from '@/types/panel';

export type SessionTabState = 'closed' | 'open' | 'current';

/** Tab membership is scoped to the visible tab bar, including every split pane. */
export function getSessionTabState(
  sessionIds: readonly string[],
  tabs: readonly Tab[],
  activeTabId: string,
  tabPanels: Readonly<Record<string, TabPanelData>>,
): SessionTabState {
  if (sessionIds.length === 0) return 'closed';
  let result: SessionTabState = 'closed';
  for (const tab of tabs) {
    const data = tabPanels[tab.id];
    if (!data) continue;
    const focusedSessionId = data.panels[data.activePanelId]?.sessionId;
    if (tab.id === activeTabId && focusedSessionId && sessionIds.includes(focusedSessionId)) {
      return 'current';
    }
    if (Object.values(data.panels).some((panel) => panel.sessionId && sessionIds.includes(panel.sessionId))) {
      result = 'open';
    }
  }
  return result;
}

/** Keep a navigation cue on the parent when the current child is capped or collapsed. */
export function getSessionTabGroupState(
  groupState: SessionTabState,
  visibleChildState: SessionTabState,
  expanded: boolean,
): SessionTabState {
  return expanded && visibleChildState === 'current' ? 'open' : groupState;
}
