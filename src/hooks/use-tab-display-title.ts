'use client';

import { useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePanelStore } from '@/stores/panel-store';
import { useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import { isSpecialSession } from '@/lib/constants/special-sessions';
import { resolveTabDisplayTitle } from '@/lib/tab/tab-display-title';
import type { Tab } from '@/types/tab';

/**
 * The name one tab shows, for a caller that renders a tab it is not inside.
 *
 * `tab-item` derives this from its own subscriptions because it renders one tab
 * per instance; the Phone viewport tab list (#247) needs the same name for every
 * open tab at once, and gets it through the same `resolveTabDisplayTitle`.
 */
export function useTabDisplayTitle(tab: Tab): string {
  const { t } = useI18n();

  const tabData = usePanelStore(
    useCallback((state) => state.tabPanels[tab.id] ?? null, [tab.id]),
  );
  const activePanel = tabData ? tabData.panels[tabData.activePanelId] : undefined;
  const activePanelSessionId = activePanel?.sessionId ?? null;
  const activePanelTerminalId = activePanel?.terminalId ?? null;

  const session = useProjectViewSession(
    activePanelSessionId && !isSpecialSession(activePanelSessionId)
      ? activePanelSessionId
      : null,
  );

  return resolveTabDisplayTitle({
    tabTitle: tab.title,
    activePanelSessionId,
    activePanelTerminalId,
    session,
    t,
  });
}
