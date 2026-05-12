'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session-store';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { hasAnyAwaitingUserPrompt, hasAnyTurnInFlight, useChatStore } from '@/stores/chat-store';
import { useI18n } from '@/lib/i18n';
import { useTabStore } from '@/stores/tab-store';
import type { Tab } from '@/types/tab';
import type { Panel, TabPanelData } from '@/types/panel';
import { SESSION_DRAG_MIME, TAB_DRAG_MIME, TAB_PANEL_TREE_DND_MIME } from '@/types/panel';
import { getSpecialSessionTitle, getSpecialSessionTitleKey, isSpecialSession } from '@/lib/constants/special-sessions';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';

/** Delay before activating a tab when a session drag hovers over it. */
const TAB_HOVER_ACTIVATE_DELAY = 500;

/** Left 30% of a tab is the "edge" zone for reorder; the rest is "center" for session drop. */
const TAB_EDGE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Props Interface
// ---------------------------------------------------------------------------

export interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  isPreview: boolean;
  isDragOver: boolean;
  isDragging?: boolean;
  style?: React.CSSProperties;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onDragStart: (tabId: string, event: React.DragEvent) => void;
  onDragOver: (tabId: string, event: React.DragEvent) => void;
  onClearDragOver: () => void;
  onDrop: (tabId: string, event: React.DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (tabId: string, event: React.MouseEvent) => void;
}

// ---------------------------------------------------------------------------
// Exported Pure Functions (testable without mounting component)
// ---------------------------------------------------------------------------

/**
 * Counts panels in the given panels map that have a non-null sessionId.
 */
export function deriveSessionCount(panels: Record<string, import('@/types/panel').Panel>): number {
  return Object.values(panels).filter((p) => p.sessionId !== null && !isSpecialSession(p.sessionId ?? '')).length;
}

/**
 * Adds a count suffix only when a tab contains multiple chat sessions.
 */
export function formatTabLabel(displayTitle: string, sessionCount: number): string {
  return sessionCount > 1 ? `${displayTitle} (${sessionCount})` : displayTitle;
}

export function getTabDragSessionId(
  panels: Record<string, Panel>,
  activePanelId: string,
): string | null {
  const activeSessionId = panels[activePanelId]?.sessionId ?? null;
  if (activeSessionId) return activeSessionId;

  const sessionIds = Object.values(panels)
    .map((panel) => panel.sessionId)
    .filter(Boolean) as string[];
  return sessionIds.length === 1 ? sessionIds[0] : null;
}

export function shouldDragTabPanelTree(tabData: TabPanelData | null | undefined): boolean {
  const panels = tabData?.panels ?? {};
  return Object.keys(panels).length > 1 || Object.values(panels).some((panel) => panel.terminalId);
}

// ---------------------------------------------------------------------------
// CVA Variant Definition (module-level, not exported)
// ---------------------------------------------------------------------------

const tabItemVariants = cva(
  // base: always applied
  'electron-no-drag relative flex h-[calc(100%+1px)] items-center select-none cursor-pointer' +
    ' px-3 py-1.5 text-sm font-medium border-b-2 transition-colors duration-100' +
    ' border-r border-r-(--divider)',
  {
    variants: {
      active: {
        true: 'bg-(--chat-bg) border-b-(--accent) text-(--text-primary)',
        false:
          'bg-transparent border-b-transparent text-(--text-muted)' +
          ' hover:text-(--text-secondary) hover:bg-(--sidebar-hover)/50',
      },
      dragOver: {
        true: 'border-l-2 border-l-(--accent)',
        false: '',
      },
      preview: {
        true: 'italic',
        false: '',
      },
    },
    defaultVariants: {
      active: false,
      dragOver: false,
      preview: false,
    },
  },
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TabItem = memo(function TabItem({
  tab,
  isActive,
  isPreview,
  isDragOver,
  isDragging = false,
  style,
  onActivate,
  onClose,
  onDragStart,
  onDragOver,
  onClearDragOver,
  onDrop,
  onDragEnd,
  onContextMenu,
}: TabItemProps) {
  const { t } = useI18n();
  // For the active tab, read live state from panel-store (authoritative source).
  // For inactive tabs, read from the tab's saved snapshot.
  const liveSessionId = usePanelStore(
    useCallback(
      (state) => {
        if (!isActive) return null;
        const tabData = selectActiveTab(state);
        return tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
      },
      [isActive],
    ),
  );

  const liveTerminalId = usePanelStore(
    useCallback(
      (state) => {
        if (!isActive) return null;
        const tabData = selectActiveTab(state);
        return tabData?.panels[tabData.activePanelId]?.terminalId ?? null;
      },
      [isActive],
    ),
  );

  const liveSessionCount = usePanelStore(
    useCallback(
      (state) => {
        if (!isActive) return 0;
        const panels = selectActiveTab(state)?.panels ?? {};
        return Object.values(panels).filter(p => p.sessionId !== null).length;
      },
      [isActive],
    ),
  );

  // For inactive tabs, read panel data from panel-store (tab.snapshot removed)
  const inactiveTabData = usePanelStore(
    useCallback(
      (state) => {
        if (isActive) return null;
        return state.tabPanels[tab.id] ?? null;
      },
      [isActive, tab.id],
    ),
  );

  const snapshotSessionId = inactiveTabData
    ? (inactiveTabData.panels[inactiveTabData.activePanelId]?.sessionId ?? null)
    : null;
  const snapshotTerminalId = inactiveTabData
    ? (inactiveTabData.panels[inactiveTabData.activePanelId]?.terminalId ?? null)
    : null;

  const activePanelSessionId = isActive ? liveSessionId : snapshotSessionId;
  const activePanelTerminalId = isActive ? liveTerminalId : snapshotTerminalId;

  // Special session handling (e.g., Skills Dashboard)
  const specialTitleKey = activePanelSessionId ? getSpecialSessionTitleKey(activePanelSessionId) : null;

  // Targeted session-store subscription — re-renders only when the specific
  // session's title changes, not on unrelated session updates.
  const session = useSessionStore(
    useCallback(
      (state) =>
        activePanelSessionId && !isSpecialSession(activePanelSessionId)
          ? state.getSession(activePanelSessionId)
          : undefined,
      [activePanelSessionId],
    ),
  );

  // Derive display values
  // Active tab: use live panel-store data; inactive tab: use snapshot
  let displayTitle = t('chat.newTabDefault');
  if (specialTitleKey) {
    displayTitle = t(specialTitleKey);
  } else if (activePanelSessionId && isSpecialSession(activePanelSessionId)) {
    displayTitle = getSpecialSessionTitle(activePanelSessionId) ?? displayTitle;
  } else if (tab.title !== null) {
    displayTitle = tab.title;
  } else if (activePanelTerminalId) {
    displayTitle = 'Terminal';
  } else if (activePanelSessionId && session) {
    displayTitle = session.title ?? session.id;
  }

  const sessionCount = isActive ? liveSessionCount : deriveSessionCount(inactiveTabData?.panels ?? {});
  const label = formatTabLabel(displayTitle, sessionCount);

  // --- Generating indicator ---
  // Active tab: read live panel sessions from panel-store
  // Inactive tab: read from tab snapshot (stable reference)
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

  const panelSessionIds = isActive
    ? livePanelSessionIds
    : Object.values(inactiveTabData?.panels ?? {})
        .map((p) => p.sessionId)
        .filter(Boolean)
        .sort()
        .join(',');

  const isGenerating = useChatStore(
    useCallback(
      (state) => {
        if (!panelSessionIds) return false;
        return hasAnyTurnInFlight(state, panelSessionIds.split(','));
      },
      [panelSessionIds],
    ),
  );

  const isAwaitingUser = useChatStore(
    useCallback(
      (state) => {
        if (!panelSessionIds) return false;
        return hasAnyAwaitingUserPrompt(state, panelSessionIds.split(','));
      },
      [panelSessionIds],
    ),
  );

  // Unread indicator — any session in this tab has unreadCount > 0.
  // Active panel's unread is auto-cleared by panel-wrapper; this surfaces
  // unread in inactive panels (same tab) and any panel of inactive tabs.
  const hasUnread = useSessionStore(
    useCallback(
      (state) => {
        if (!panelSessionIds) return false;
        return panelSessionIds.split(',').some((id) => {
          const s = state.getSession(id);
          return s ? (s.unreadCount ?? 0) > 0 : false;
        });
      },
      [panelSessionIds],
    ),
  );

  // Session drag hover state + timer
  const hoverActivateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickAfterDragRef = useRef(false);
  const [isSessionDragHover, setIsSessionDragHover] = useState(false);

  // Event handlers — all stable references via useCallback

  const handleClick = useCallback(
    function handleClick() {
      if (suppressClickAfterDragRef.current) return;
      onActivate(tab.id);
    },
    [onActivate, tab.id],
  );

  const handleCloseMouseDown = useCallback(
    function handleCloseMouseDown(e: React.MouseEvent) {
      e.stopPropagation();
      onClose(tab.id);
    },
    [onClose, tab.id],
  );

  const clearHoverTimer = useCallback(() => {
    if (hoverActivateTimerRef.current) {
      clearTimeout(hoverActivateTimerRef.current);
      hoverActivateTimerRef.current = null;
    }
    setIsSessionDragHover(false);
  }, []);

  const handleDragStart = useCallback(
    function handleDragStart(e: React.DragEvent) {
      suppressClickAfterDragRef.current = true;
      e.dataTransfer.effectAllowed = 'move';
      onDragStart(tab.id, e);

      // Mark as tab drag (distinguishes from sidebar session drags)
      e.dataTransfer.setData(TAB_DRAG_MIME, tab.id);

      // The active panel session can be dropped onto another panel.
      const tabData = isActive
        ? selectActiveTab(usePanelStore.getState())
        : usePanelStore.getState().tabPanels[tab.id];
      const dragSessionId = tabData ? getTabDragSessionId(tabData.panels, tabData.activePanelId) : null;
      if (dragSessionId) {
        e.dataTransfer.setData(SESSION_DRAG_MIME, dragSessionId);
      }
      if (shouldDragTabPanelTree(tabData)) {
        e.dataTransfer.setData(TAB_PANEL_TREE_DND_MIME, tab.id);
      }
    },
    [onDragStart, tab.id, isActive],
  );

  const handleDragOver = useCallback(
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const isTabDrag = e.dataTransfer.types.includes(TAB_DRAG_MIME);
      const isSessionDrag = e.dataTransfer.types.includes(SESSION_DRAG_MIME);

      if (isTabDrag && isSessionDrag) {
        // Tab drag with session: zone-based exclusive indicators.
        // Left edge → reorder (left border), center → session hover (bottom highlight).
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;

        if (x < TAB_EDGE_THRESHOLD) {
          // Edge zone — reorder indicator
          onDragOver(tab.id, e);
          clearHoverTimer();
        } else {
          // Center zone — session hover indicator
          onClearDragOver();
          if (!isActive) {
            setIsSessionDragHover(true);
            if (!hoverActivateTimerRef.current) {
              hoverActivateTimerRef.current = setTimeout(() => {
                hoverActivateTimerRef.current = null;
                setIsSessionDragHover(false);
                useTabStore.getState().setActiveTab(tab.id);
              }, TAB_HOVER_ACTIVATE_DELAY);
            }
          }
        }
      } else if (isSessionDrag) {
        // Pure session drag (sidebar) — session hover only
        if (!isActive) {
          setIsSessionDragHover(true);
          if (!hoverActivateTimerRef.current) {
            hoverActivateTimerRef.current = setTimeout(() => {
              hoverActivateTimerRef.current = null;
              setIsSessionDragHover(false);
              useTabStore.getState().setActiveTab(tab.id);
            }, TAB_HOVER_ACTIVATE_DELAY);
          }
        }
      } else {
        // Pure tab drag (multi-session tab, no session) — reorder only
        onDragOver(tab.id, e);
      }
    },
    [onDragOver, onClearDragOver, tab.id, isActive, clearHoverTimer],
  );

  const handleDragLeave = useCallback(
    function handleDragLeave() {
      clearHoverTimer();
    },
    [clearHoverTimer],
  );

  const handleDrop = useCallback(
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      clearHoverTimer();
      onDrop(tab.id, e);
    },
    [onDrop, tab.id, clearHoverTimer],
  );

  const handleDragEnd = useCallback(
    function handleDragEnd() {
      clearHoverTimer();
      onDragEnd();
      window.setTimeout(() => {
        suppressClickAfterDragRef.current = false;
      }, 150);
    },
    [onDragEnd, clearHoverTimer],
  );

  const handleContextMenu = useCallback(
    function handleContextMenu(e: React.MouseEvent) {
      e.preventDefault();
      onContextMenu(tab.id, e);
    },
    [onContextMenu, tab.id],
  );

  return (
    <div
      draggable
      role="tab"
      aria-selected={isActive}
      aria-controls={`${tab.id}-panel`}
      id={tab.id}
      title={displayTitle}
      style={style}
      className={cn(
        tabItemVariants({ active: isActive, dragOver: isDragOver && !isSessionDragHover, preview: isPreview }),
        isDragging && [
          'z-20 scale-[0.98]',
          'border-b-(--accent) bg-[color-mix(in_srgb,var(--accent)_14%,var(--chat-header-bg))]',
          'text-(--text-primary) opacity-75 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_38%,transparent)]',
        ],
        isDragOver && !isSessionDragHover && !isDragging && [
          'bg-[color-mix(in_srgb,var(--accent)_10%,var(--chat-header-bg))]',
          'shadow-[inset_2px_0_0_var(--accent)]',
        ],
        isSessionDragHover && !isDragOver && 'border-b-(--accent) bg-(--accent)/10',
      )}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
      data-testid="tab-item"
      data-tab-id={tab.id}
      data-project-dir={tab.projectDir ?? 'global'}
      data-active={String(isActive)}
      data-dragging={String(isDragging)}
      aria-grabbed={isDragging || undefined}
    >
      {/* Leading indicator — generating spinner takes precedence over user attention/unread dots */}
      {isGenerating ? (
        <div className="w-3 h-3 shrink-0 mr-1.5 rounded-full border-2 border-(--success)/30 border-t-(--success) animate-spin" />
      ) : isAwaitingUser ? (
        <div
          className="h-[7px] w-[7px] shrink-0 mr-1.5 rounded-full bg-[#facc15] attention-dot-blink"
          data-testid="tab-item-attention"
          aria-label={t('status.inputRequired')}
        />
      ) : hasUnread ? (
        <div
          className="h-[6px] w-[6px] shrink-0 mr-1.5 rounded-full bg-[#facc15]"
          data-testid="tab-item-unread"
          aria-label="Unread messages"
        />
      ) : null}

      {/* Title area — truncated with ellipsis (BR-UI-022) */}
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
        {label}
      </span>

      {/* Close button — always visible (BR-UI-024) */}
      <ShortcutTooltip id="close-tab" label={t('shortcut.closeTab')}>
        <button
          className="ml-1.5 shrink-0 rounded hover:bg-(--sidebar-hover) p-0.5"
          onMouseDown={handleCloseMouseDown}
          aria-label={t('chat.closeTab', { title: displayTitle })}
          data-testid="tab-item-close"
          tabIndex={-1}
        >
          <X size={12} />
        </button>
      </ShortcutTooltip>
    </div>
  );
});
