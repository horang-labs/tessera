'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { cva } from 'class-variance-authority';
import { Columns2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session-store';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useAnySessionAwaitingUser } from '@/hooks/use-session-awaiting-user';
import { useAnyProjectViewSessionUnread } from '@/hooks/use-project-view-session-unread';
import {
  useProjectViewSession,
  useProjectViewSessions,
} from '@/hooks/use-project-view-workspace-state';
import { useI18n } from '@/lib/i18n';
import { useTabStore } from '@/stores/tab-store';
import type { Tab } from '@/types/tab';
import type { Panel, TabPanelData } from '@/types/panel';
import { SESSION_DRAG_MIME, TAB_DRAG_MIME, TAB_PANEL_TREE_DND_MIME } from '@/types/panel';
import { isSpecialSession } from '@/lib/constants/special-sessions';
import { resolveTabDisplayTitle } from '@/lib/tab/tab-display-title';
import { requestSessionRename } from '@/lib/session/rename-session-request';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { useSessionProcessingSummary } from '@/hooks/use-session-processing';
import { ItemStatusIndicator } from '@/components/chat/work-item-primitives';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import { transitionTabClickSuppression } from '@/lib/tab/tab-drag-click-guard';
import { captureTelemetryUiControl } from '@/lib/telemetry/client';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

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

/** Counts every panel, including empty and terminal-only panels. */
export function derivePanelCount(panels: Record<string, Panel>): number {
  return Object.keys(panels).length;
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

export type TabTitleCommit =
  | { kind: 'session'; sessionId: string; title: string }
  | { kind: 'tab'; title: string | null }
  | { kind: 'noop' };

/**
 * 탭 제목 편집을 어디에 반영할지 결정한다.
 *
 * 탭에 보이는 제목은 활성 패널 세션의 제목이므로, rename 가능한 세션이 있으면
 * 세션을 rename해야 사이드바·태스크·DB가 함께 따라온다. 탭 전용 제목은 rename할
 * 세션이 없는 탭(빈 탭, 세션 없는 터미널 패널, 특수 세션)에서만 쓴다.
 */
export function resolveTabTitleCommit({
  nextTitle,
  displayTitle,
  tabTitle,
  renameTargetSessionId,
}: {
  nextTitle: string;
  displayTitle: string;
  tabTitle: string | null;
  renameTargetSessionId: string | null;
}): TabTitleCommit {
  if (renameTargetSessionId) {
    if (!nextTitle || nextTitle === displayTitle) return { kind: 'noop' };
    return { kind: 'session', sessionId: renameTargetSessionId, title: nextTitle };
  }
  if (!nextTitle) {
    return tabTitle !== null ? { kind: 'tab', title: null } : { kind: 'noop' };
  }
  if (nextTitle === displayTitle) return { kind: 'noop' };
  return { kind: 'tab', title: nextTitle };
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
  'relative flex h-[calc(100%+1px)] items-center select-none cursor-pointer' +
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

  const livePanelCount = usePanelStore(
    useCallback(
      (state) => {
        if (!isActive) return 0;
        const panels = selectActiveTab(state)?.panels ?? {};
        return derivePanelCount(panels);
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

  const session = useProjectViewSession(
    activePanelSessionId && !isSpecialSession(activePanelSessionId)
      ? activePanelSessionId
      : null,
  );

  // Derive display values
  // Active tab: use live panel-store data; inactive tab: use snapshot
  const displayTitle = resolveTabDisplayTitle({
    tabTitle: tab.title,
    activePanelSessionId,
    activePanelTerminalId,
    session,
    t,
  });

  // 특수 세션(Skills Dashboard 등)은 rename 대상이 아니다 — 탭 로컬 제목으로 남긴다.
  const renameTargetSessionId =
    activePanelSessionId && !isSpecialSession(activePanelSessionId) && session
      ? activePanelSessionId
      : null;

  const panelCount = isActive
    ? livePanelCount
    : derivePanelCount(inactiveTabData?.panels ?? {});
  const isMultiPanel = panelCount > 1;
  const multiPanelLabel = t('chat.multiPanelTab', { count: panelCount });

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

  const { hasProcessingSession: isGenerating, hasTerminalProcessingSession } =
    useSessionProcessingSummary(panelSessionIds ? panelSessionIds.split(',') : []);

  const isAwaitingUser = useAnySessionAwaitingUser(
    panelSessionIds ? panelSessionIds.split(',') : [],
  );

  // Runtime liveness — the green "session is up but idle" dot the sidebar shows.
  const resolvedPanelSessions = useProjectViewSessions(
    panelSessionIds ? panelSessionIds.split(',') : [],
  );
  const isRunning = resolvedPanelSessions.some(
    (resolvedSession) => resolveSessionRuntimePresentation(resolvedSession).showRunning,
  );

  // Unread indicator — any session in this tab has unreadCount > 0.
  // Active panel's unread is auto-cleared by panel-wrapper; this surfaces
  // unread in inactive panels (same tab) and any panel of inactive tabs.
  const hasUnread = useAnyProjectViewSessionUnread(
    panelSessionIds ? panelSessionIds.split(',') : [],
  );

  // Mirror ItemStatusIndicator's own priority so the label/testid describe the
  // dot that actually renders.
  const statusKind = isAwaitingUser
    ? 'awaiting'
    : isGenerating && (hasTerminalProcessingSession || !hasUnread)
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

  // Session drag hover state + timer
  const hoverActivateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickAfterDragRef = useRef(false);
  const [isSessionDragHover, setIsSessionDragHover] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(displayTitle);

  // Event handlers — all stable references via useCallback

  const handleClick = useCallback(
    function handleClick() {
      const transition = transitionTabClickSuppression(
        suppressClickAfterDragRef.current,
        'click',
      );
      suppressClickAfterDragRef.current = transition.suppressed;
      if (!transition.shouldActivate || isEditingTitle) return;
      void captureTelemetryUiControl('tab.select', 'tab_bar');
      onActivate(tab.id);
    },
    [isEditingTitle, onActivate, tab.id],
  );

  const handlePointerDown = useCallback(function handlePointerDown() {
    suppressClickAfterDragRef.current = transitionTabClickSuppression(
      suppressClickAfterDragRef.current,
      'pointer-down',
    ).suppressed;
  }, []);

  const handleDoubleClick = useCallback(
    function handleDoubleClick(e: React.MouseEvent) {
      e.stopPropagation();
      setTitleInput(displayTitle);
      setIsEditingTitle(true);
    },
    [displayTitle],
  );

  const commitTitleEdit = useCallback(() => {
    const commit = resolveTabTitleCommit({
      nextTitle: titleInput.trim(),
      displayTitle,
      tabTitle: tab.title,
      renameTargetSessionId,
    });
    setIsEditingTitle(false);

    if (commit.kind === 'session') {
      // 예전에 붙여둔 탭 로컬 제목이 남아 있으면 새 세션 제목을 계속 가린다.
      if (tab.title !== null) {
        useTabStore.getState().renameTab(tab.id, null);
      }
      useTabStore.getState().pinTab(tab.id);
      void requestSessionRename(commit.sessionId, commit.title, t);
    } else if (commit.kind === 'tab') {
      useTabStore.getState().renameTab(tab.id, commit.title);
    }
  }, [displayTitle, renameTargetSessionId, t, tab.id, tab.title, titleInput]);

  const cancelTitleEdit = useCallback(() => {
    setTitleInput(displayTitle);
    setIsEditingTitle(false);
  }, [displayTitle]);

  const handleTitleInputKeyDown = useCallback(
    function handleTitleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTitleEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelTitleEdit();
      }
    },
    [cancelTitleEdit, commitTitleEdit],
  );

  const handleCloseMouseDown = useCallback(
    function handleCloseMouseDown(e: React.MouseEvent) {
      e.stopPropagation();
      void captureTelemetryUiControl('tab.close', 'tab_bar');
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
      suppressClickAfterDragRef.current = transitionTabClickSuppression(
        suppressClickAfterDragRef.current,
        'drag-start',
      ).suppressed;
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
        suppressClickAfterDragRef.current = transitionTabClickSuppression(
          suppressClickAfterDragRef.current,
          'reset',
        ).suppressed;
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
      data-telemetry-ignore="manual_capture"
      draggable={!isEditingTitle}
      role="tab"
      aria-selected={isActive}
      aria-controls={`${tab.id}-panel`}
      id={tab.id}
      title={isMultiPanel ? `${displayTitle} · ${multiPanelLabel}` : displayTitle}
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
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
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
      {/* Leading indicator — same dots, colors and priority as the sidebar/board */}
      {statusKind && (
        <span
          className="mr-1.5 flex shrink-0 items-center"
          data-testid="tab-item-status"
          data-status={statusKind}
          aria-label={statusLabel}
          title={statusLabel}
        >
          <ItemStatusIndicator
            isProcessing={isGenerating}
            isAwaitingUser={isAwaitingUser}
            hasUnread={hasUnread}
            isRunning={isRunning}
            sessionKind={hasTerminalProcessingSession ? 'terminal' : undefined}
            placement="inline"
            size="lg"
            surface="sidebar"
          />
        </span>
      )}

      {/* Title area — truncated with ellipsis (BR-UI-022) */}
      {isEditingTitle ? (
        <input
          {...telemetryClickAttributes('tab.rename', 'tab_bar')}
          type="text"
          value={titleInput}
          onChange={(e) => setTitleInput(e.target.value)}
          onBlur={commitTitleEdit}
          onKeyDown={handleTitleInputKeyDown}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={t('chat.renameTab', { title: displayTitle })}
          className="h-6 min-w-0 flex-1 rounded border border-(--input-border) bg-(--input-bg) px-1.5 text-sm font-medium text-(--text-primary) outline-none focus:ring-1 focus:ring-(--accent)"
          data-testid="tab-title-input"
          data-tab-title-editor="true"
          autoFocus
        />
      ) : (
        <ShortcutTooltip
          id="prev-tab"
          label={t('shortcut.prevTab')}
          secondaryId="next-tab"
          secondaryLabel={t('shortcut.nextTab')}
        >
          <span className="flex min-w-0 flex-1 items-center">
            {isMultiPanel ? (
              <span
                aria-label={multiPanelLabel}
                className="mr-1.5 flex shrink-0 items-center gap-1 text-[11px] font-semibold leading-none text-(--accent-light)"
                data-testid="tab-item-panel-count"
                data-panel-count={panelCount}
                title={multiPanelLabel}
              >
                <Columns2 aria-hidden="true" size={11} strokeWidth={2} />
                <span>{panelCount}</span>
              </span>
            ) : null}
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {displayTitle}
            </span>
          </span>
        </ShortcutTooltip>
      )}

      {/* Close button — always visible (BR-UI-024) */}
      <ShortcutTooltip id="close-tab" label={t('shortcut.closeTab')}>
        <button
          data-telemetry-ignore="manual_capture"
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
