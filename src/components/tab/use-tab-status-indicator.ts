'use client';

import { useCallback } from 'react';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useSessionProcessingSummary } from '@/hooks/use-session-processing';
import { useAnySessionAwaitingUser } from '@/hooks/use-session-awaiting-user';
import { useAnyProjectViewSessionUnread } from '@/hooks/use-project-view-session-unread';
import { useI18n } from '@/lib/i18n';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import type { Tab } from '@/types/tab';

export type TabStatusKind = 'awaiting' | 'processing' | 'unread' | 'running' | null;

/**
 * The dot the sidebar / tab strip / tab list all draw beside a tab's title.
 * Extracted so `TabItem` and `TabListItem` (the phone-viewport control) render
 * exactly the same indicator with the same priority.
 */
export function useTabStatusIndicator(tab: Tab, isActive: boolean) {
  const { t } = useI18n();

  const livePanelSessionIds = usePanelStore(
    useCallback(
      (state) => {
        if (!isActive) return '';
        const panels = selectActiveTab(state)?.panels ?? {};
        return Object.values(panels)
          .map((p) => p.sessionId)
          .filter(Boolean)
          .sort()
          .join(',');
      },
      [isActive],
    ),
  );

  const inactiveTabData = usePanelStore(
    useCallback(
      (state) => {
        if (isActive) return null;
        return state.tabPanels[tab.id] ?? null;
      },
      [isActive, tab.id],
    ),
  );

  const panelSessionIds = isActive
    ? livePanelSessionIds
    : Object.values(inactiveTabData?.panels ?? {})
        .map((p) => p.sessionId)
        .filter(Boolean)
        .sort()
        .join(',');

  const sessionIdList = panelSessionIds ? panelSessionIds.split(',') : [];

  const { hasProcessingSession: isProcessing, hasTerminalProcessingSession } =
    useSessionProcessingSummary(sessionIdList);

  const isAwaitingUser = useAnySessionAwaitingUser(sessionIdList);

  const isRunning = useSessionStore(
    useCallback(
      (state) => {
        if (!panelSessionIds) return false;
        return panelSessionIds.split(',').some((id) => {
          const s = state.getSession(id);
          return s ? resolveSessionRuntimePresentation(s).showRunning : false;
        });
      },
      [panelSessionIds],
    ),
  );

  const hasUnread = useAnyProjectViewSessionUnread(sessionIdList);

  // Same priority ladder as ItemStatusIndicator so the label/testid match the
  // dot that actually renders.
  const statusKind: TabStatusKind = isAwaitingUser
    ? 'awaiting'
    : isProcessing && (hasTerminalProcessingSession || !hasUnread)
      ? 'processing'
      : hasUnread
        ? 'unread'
        : isRunning
          ? 'running'
          : null;

  const statusLabel =
    statusKind === 'awaiting'
      ? t('status.inputRequired')
      : statusKind === 'processing'
        ? t('status.processing')
        : statusKind === 'unread'
          ? t('status.unreadNotification')
          : statusKind === 'running'
            ? t('status.sessionRunning')
            : undefined;

  return {
    statusKind,
    statusLabel,
    isProcessing,
    isAwaitingUser,
    isRunning,
    hasUnread,
    hasTerminalProcessingSession,
  };
}
