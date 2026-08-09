import { activateSessionPanel } from '@/lib/session/focus-session-panel';
import { switchToSessionProject } from '@/lib/session/switch-session-project';
import { isPendingTerminalReboundDestination } from '@/lib/terminal/terminal-session-rebound-reservations';
import { selectActiveTab, usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';

export type ActiveSessionSurfaceReconciliation =
  | 'already-active'
  | 'reserved'
  | 'activated'
  | 'assigned'
  | 'deferred';

/**
 * Reconciles session-store selection with the tab/panel topology.
 * Hidden project snapshots count as existing surfaces, while a rebound
 * destination is never assigned before its source PTY surface is transferred.
 */
export function reconcileActiveSessionSurface(
  activeSessionId: string,
): ActiveSessionSurfaceReconciliation {
  const panelState = usePanelStore.getState();
  const activeTabData = selectActiveTab(panelState);
  const currentPanelSessionId =
    activeTabData?.panels[activeTabData.activePanelId]?.sessionId ?? null;

  if (activeSessionId === currentPanelSessionId) {
    useTabStore.getState().syncTabProjectFromSession(panelState.activeTabId, activeSessionId);
    return 'already-active';
  }

  if (isPendingTerminalReboundDestination(activeSessionId)) return 'reserved';

  const tabStore = useTabStore.getState();
  const surface = tabStore.findSessionSurface(activeSessionId);
  if (surface) {
    const isMaterialized = tabStore.tabs.some((tab) => tab.id === surface.tabId);
    if (!isMaterialized) {
      // Global tabs should always be materialized. If one is not, avoid creating
      // a duplicate and wait for the next scope reconciliation instead.
      if (surface.projectDir === null) return 'deferred';
      if (!switchToSessionProject(surface.projectDir)) return 'deferred';
    }

    const location = useTabStore.getState().findSessionLocation(activeSessionId);
    if (!location) return 'deferred';
    activateSessionPanel(activeSessionId, { location });
    return 'activated';
  }

  panelState.assignSession(activeTabData?.activePanelId ?? '', activeSessionId);
  useTabStore.getState().syncTabProjectFromSession(panelState.activeTabId, activeSessionId);
  return 'assigned';
}
