import { useCallback, useMemo } from 'react';
import type React from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useNotificationStore } from '@/stores/notification-store';
import { useSelectionStore } from '@/stores/selection-store';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { wsClient } from '@/lib/ws/client';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import type { UnifiedSession } from '@/types/chat';

/**
 * useSessionClickHandlers
 *
 * Encapsulates handleSessionClick and handleSessionDoubleClick, extracted from
 * Sidebar so they can be reused by the Task Board sidebar without duplication.
 *
 * Business rules preserved: BR-SIDEBAR-001 through BR-SIDEBAR-009, BR-EDGE-001, BR-EDGE-003.
 */
export function useSessionClickHandlers(options?: {
  /** Ordered list of session IDs in the current view (for Shift+Click range select) */
  orderedIds?: string[];
}): {
  handleSessionClick: (session: UnifiedSession, event?: React.MouseEvent) => Promise<void>;
  handleSessionDoubleClick: (session: UnifiedSession) => Promise<void>;
} {
  // Reactive subscriptions
  const clearUnreadCount = useSessionStore((state) => state.clearUnreadCount);
  const notifications = useNotificationStore((state) => state.notifications);
  // Derived from reactive subscription — plain const, recomputed each render
  const unreadSessionIds = useMemo(
    () => new Set(notifications.filter((n) => !n.read).map((n) => n.sessionId)),
    [notifications],
  );

  const { viewSession } = useSessionNavigation();

  // Handle session click — multi-tab aware rewrite (BR-SIDEBAR-009, BR-SIDEBAR-001 through BR-SIDEBAR-007)
  const handleSessionClick = useCallback(
    async (session: UnifiedSession, event?: React.MouseEvent): Promise<void> => {
      // BRANCH A — Ctrl/Meta+click: multi-select toggle
      if (event && (event.ctrlKey || event.metaKey)) {
        const selStore = useSelectionStore.getState();
        // First Ctrl+Click: include the currently active session as anchor
        if (selStore.selectedIds.size === 0) {
          const activeId = getSessionSelectionId(useSessionStore.getState().activeSessionId);
          if (activeId && activeId !== session.id) {
            selStore.toggleSelect(activeId);
          }
        }
        selStore.toggleSelect(session.id);
        return;
      }

      // BRANCH A2 — Shift+click: range select from active session
      if (event && event.shiftKey) {
        const selStore = useSelectionStore.getState();
        const oids = options?.orderedIds ?? [];
        // Use active session as anchor when no prior Ctrl+Click anchor exists
        if (!selStore.lastClickedId) {
          const activeId = getSessionSelectionId(useSessionStore.getState().activeSessionId);
          if (activeId) {
            selStore.toggleSelect(activeId); // sets lastClickedId to activeId
          }
        }
        selStore.rangeSelect(session.id, oids);
        return;
      }

      // Clear multi-select when doing a normal click
      if (useSelectionStore.getState().selectedIds.size > 0) {
        useSelectionStore.getState().clearSelection();
      }

      // BRANCH B — Normal click

      // 1. Clear unread count (BR-SIDEBAR-008: only for normal click paths)
      if (unreadSessionIds.has(session.id)) {
        clearUnreadCount(session.id);
        wsClient.sendMarkAsRead(session.id);
      }

      // 2. Cross-tab location search (BR-SIDEBAR-004: replaces isInAnotherPanel)
      const location = useTabStore.getState().findSessionLocation(session.id);
      const currentActiveTabId = useTabStore.getState().activeTabId;

      if (location) {
        if (location.tabId !== currentActiveTabId) {
          // CASE B1 — Session found in ANOTHER tab (BR-SIDEBAR-005)
          // Order matters: setActiveTab BEFORE setActivePanelId (BR-EDGE-003)
          useTabStore.getState().setActiveTab(location.tabId);
          usePanelStore.getState().setActivePanelId(location.panelId);
        } else {
          // CASE B2 — Session found in ACTIVE TAB (BR-SIDEBAR-006)
          usePanelStore.getState().setActivePanelId(location.panelId);
        }
        return;
      }

      // CASE B3 — Session NOT found anywhere (BR-SIDEBAR-007)
      // 싱글클릭은 항상 프리뷰 탭으로 열기 (빈 패널이든 세션이 있든)
      useTabStore.getState().openPreview(session.id);
      await viewSession(session);
    },
    [unreadSessionIds, clearUnreadCount, viewSession, options?.orderedIds]
  );

  // Handle session double-click — always opens as pinned tab
  const handleSessionDoubleClick = useCallback(
    async (session: UnifiedSession): Promise<void> => {
      const tabStore = useTabStore.getState();
      const location = tabStore.findSessionLocation(session.id);
      if (location) {
        // 이미 열려있으면 해당 탭으로 이동 + 고정
        tabStore.setActiveTab(location.tabId);
        tabStore.pinTab(location.tabId);
      } else {
        // 새 고정 탭으로 열기
        tabStore.createTabWithSession(session.id);
      }
      await viewSession(session);
    },
    [viewSession]
  );

  return { handleSessionClick, handleSessionDoubleClick };
}
