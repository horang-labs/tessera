'use client';

import { getSessionTabState } from '@/lib/workspace-tabs/session-tab-state';
import { useTabStore } from '@/stores/tab-store';
import { usePanelStore } from '@/stores/panel-store';

export function useSessionTabState(sessionIds: string | readonly string[]) {
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const ids = typeof sessionIds === 'string' ? [sessionIds] : sessionIds;
  // Select a primitive so unrelated panel activity does not rerender every row.
  return usePanelStore((state) => getSessionTabState(ids, tabs, activeTabId, state.tabPanels));
}
