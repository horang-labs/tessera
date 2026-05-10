'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, PanelLeft, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useTabStore } from '@/stores/tab-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { TAB_MIN_WIDTH, TAB_MAX_WIDTH } from '@/types/tab';
import { PANEL_NODE_DRAG_MIME, PANEL_SESSION_DRAG_MIME } from '@/types/panel';
import { useGitStore } from '@/stores/git-store';
import { TabItem } from './tab-item';
import { TabContextMenu } from './tab-context-menu';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { parsePanelNodeDragData, parsePanelTitleDragData } from '@/lib/dnd/panel-session-drag';

const TAB_SCROLL_MIN_STEP = 180;
const TAB_SCROLL_EDGE_EPSILON = 1;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the tab bar with tab items and the "+" button.
 * Reads all data from tab-store — no props required.
 */
export const TabBar = memo(function TabBar() {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const isMacElectron = electronPlatform === 'darwin';
  const isWindowsElectron = electronPlatform === 'win32';
  // Store subscriptions — minimal slices to avoid unnecessary re-renders
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((state) => state.toggleSidebar);
  const gitPanelOpen = useGitStore((state) => state.isOpen);
  const toggleGitPanel = useGitStore((state) => state.toggle);

  // Scrollable container ref
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ canScrollLeft: false, canScrollRight: false });

  // DnD state (BR-UI-020)
  const dragTabIdRef = useRef<string | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [isCreateTabDragOver, setIsCreateTabDragOver] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    position: { x: number; y: number };
  } | null>(null);

  // Track previous tab count for scroll-to-new-tab effect
  const prevTabCountRef = useRef(tabs.length);

  const updateScrollState = useCallback(function updateScrollState() {
    const container = containerRef.current;
    if (!container) {
      setScrollState((prev) =>
        prev.canScrollLeft || prev.canScrollRight
          ? { canScrollLeft: false, canScrollRight: false }
          : prev,
      );
      return;
    }

    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const next = {
      canScrollLeft: container.scrollLeft > TAB_SCROLL_EDGE_EPSILON,
      canScrollRight: container.scrollLeft < maxScrollLeft - TAB_SCROLL_EDGE_EPSILON,
    };

    setScrollState((prev) =>
      prev.canScrollLeft === next.canScrollLeft && prev.canScrollRight === next.canScrollRight
        ? prev
        : next,
    );
  }, []);

  useEffect(
    function trackTabOverflow() {
      const container = containerRef.current;
      if (!container) return;

      let frameId = 0;
      const scheduleUpdate = () => {
        cancelAnimationFrame(frameId);
        frameId = requestAnimationFrame(updateScrollState);
      };

      scheduleUpdate();

      const resizeObserver =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
      resizeObserver?.observe(container);
      container.addEventListener('scroll', scheduleUpdate, { passive: true });
      window.addEventListener('resize', scheduleUpdate);

      return () => {
        cancelAnimationFrame(frameId);
        resizeObserver?.disconnect();
        container.removeEventListener('scroll', scheduleUpdate);
        window.removeEventListener('resize', scheduleUpdate);
      };
    },
    [updateScrollState],
  );

  useEffect(
    function syncTabOverflowAfterRender() {
      const frameId = requestAnimationFrame(updateScrollState);
      return () => cancelAnimationFrame(frameId);
    },
    [tabs, updateScrollState],
  );

  // Scroll to newly added tab (BR-UI-019 / UX improvement)
  useEffect(
    function scrollToNewTab() {
      if (tabs.length > prevTabCountRef.current) {
        const container = containerRef.current;
        const tabElements = container
          ? Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'))
          : [];
        const activeTabElement = tabElements.find((element) => element.dataset.tabId === activeTabId);

        activeTabElement?.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: 'smooth',
        });
      }
      prevTabCountRef.current = tabs.length;
      const frameId = requestAnimationFrame(updateScrollState);
      return () => cancelAnimationFrame(frameId);
    },
    [activeTabId, tabs.length, updateScrollState],
  );

  // ---------------------------------------------------------------------------
  // Stable action callbacks
  // ---------------------------------------------------------------------------

  const handleAddTab = useCallback(function handleAddTab() {
    useTabStore.getState().createTab();
  }, []);

  const clearTabDragState = useCallback(function clearTabDragState() {
    dragTabIdRef.current = null;
    setDraggingTabId(null);
    setDragOverTabId(null);
  }, []);

  const hasPanelTitleDrag = useCallback(function hasPanelTitleDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes(PANEL_SESSION_DRAG_MIME);
  }, []);

  const hasPanelNodeDrag = useCallback(function hasPanelNodeDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes(PANEL_NODE_DRAG_MIME);
  }, []);

  const handlePanelTitleDropToNewTab = useCallback(function handlePanelTitleDropToNewTab(
    e: React.DragEvent,
  ): boolean {
    const payload = parsePanelTitleDragData(e.dataTransfer);
    if (!payload) return false;

    const panelStore = usePanelStore.getState();
    const tabStore = useTabStore.getState();
    const previousActiveTabId = tabStore.activeTabId;
    const sourceTabData = panelStore.tabPanels[payload.tabId];
    const sourcePanel = sourceTabData?.panels[payload.panelId];
    if (!sourceTabData || sourcePanel?.sessionId !== payload.sessionId) return false;

    panelStore.assignSessionInTab(payload.tabId, payload.panelId, null);

    const newTabId = tabStore.createTab(payload.sessionId, { insertAfterTabId: payload.tabId });
    if (previousActiveTabId && previousActiveTabId !== newTabId) {
      useTabStore.getState().setActiveTab(previousActiveTabId);
    }
    return true;
  }, []);

  const handlePanelNodeDropToNewTab = useCallback(function handlePanelNodeDropToNewTab(
    e: React.DragEvent,
  ): boolean {
    const payload = parsePanelNodeDragData(e.dataTransfer);
    if (!payload) return false;

    const panelStore = usePanelStore.getState();
    const tabStore = useTabStore.getState();
    const previousActiveTabId = tabStore.activeTabId;
    const sourceTabData = panelStore.tabPanels[payload.tabId];
    const sourcePanel = sourceTabData?.panels[payload.panelId];
    const terminalId = sourcePanel?.terminalId ?? null;
    const terminalSessionId = sourcePanel?.terminalSessionId ?? null;
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
    usePanelStore.getState().assignTerminal(newPanelId, terminalId, terminalSessionId);

    if (previousActiveTabId && previousActiveTabId !== newTabId) {
      useTabStore.getState().setActiveTab(previousActiveTabId);
    }
    return true;
  }, []);

  const handleCreateTabDragOver = useCallback(function handleCreateTabDragOver(e: React.DragEvent) {
    if (!hasPanelTitleDrag(e) && !hasPanelNodeDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsCreateTabDragOver(true);
  }, [hasPanelNodeDrag, hasPanelTitleDrag]);

  const handleCreateTabDragLeave = useCallback(function handleCreateTabDragLeave() {
    setIsCreateTabDragOver(false);
  }, []);

  const handleCreateTabDrop = useCallback(function handleCreateTabDrop(e: React.DragEvent) {
    if (!hasPanelTitleDrag(e) && !hasPanelNodeDrag(e)) return;
    e.preventDefault();
    setIsCreateTabDragOver(false);
    if (handlePanelTitleDropToNewTab(e) || handlePanelNodeDropToNewTab(e)) {
      clearTabDragState();
    }
  }, [clearTabDragState, handlePanelNodeDropToNewTab, handlePanelTitleDropToNewTab, hasPanelNodeDrag, hasPanelTitleDrag]);

  const handleScrollTabs = useCallback(function handleScrollTabs(direction: 'left' | 'right') {
    const container = containerRef.current;
    if (!container) return;

    const distance = Math.max(TAB_SCROLL_MIN_STEP, Math.floor(container.clientWidth * 0.7));
    container.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  }, []);

  const handleTabActivate = useCallback(function handleTabActivate(tabId: string) {
    const tabStore = useTabStore.getState();
    if (tabId === tabStore.activeTabId) return;
    tabStore.setActiveTab(tabId);
  }, []);

  const handleTabClose = useCallback(function handleTabClose(tabId: string) {
    useTabStore.getState().closeTab(tabId);
  }, []);

  // ---------------------------------------------------------------------------
  // Context menu handlers
  // ---------------------------------------------------------------------------

  const handleContextMenu = useCallback(function handleContextMenu(
    tabId: string,
    event: React.MouseEvent,
  ) {
    setContextMenu({ tabId, position: { x: event.clientX, y: event.clientY } });
  }, []);

  const handleContextMenuClose = useCallback(function handleContextMenuClose() {
    setContextMenu(null);
  }, []);

  const handleCloseOtherTabs = useCallback(function handleCloseOtherTabs() {
    if (contextMenu) useTabStore.getState().closeOtherTabs(contextMenu.tabId);
  }, [contextMenu]);

  const handleCloseTabsToLeft = useCallback(function handleCloseTabsToLeft() {
    if (contextMenu) useTabStore.getState().closeTabsToLeft(contextMenu.tabId);
  }, [contextMenu]);

  const handleCloseTabsToRight = useCallback(function handleCloseTabsToRight() {
    if (contextMenu) useTabStore.getState().closeTabsToRight(contextMenu.tabId);
  }, [contextMenu]);

  const handleCloseAllTabs = useCallback(function handleCloseAllTabs() {
    useTabStore.getState().closeAllTabs();
  }, []);

  // ---------------------------------------------------------------------------
  // DnD handlers
  // ---------------------------------------------------------------------------

  const handleDragStart = useCallback(function handleDragStart(
    tabId: string,
    _event: React.DragEvent,
  ) {
    dragTabIdRef.current = tabId;
    setDraggingTabId(tabId);
  },
  []);

  const handleDragOver = useCallback(function handleDragOver(
    tabId: string,
    _event: React.DragEvent,
  ) {
    // Only show reorder indicator for tab-to-tab drags (not session drags)
    if (!dragTabIdRef.current || tabId === dragTabIdRef.current) {
      setDragOverTabId(null);
      return;
    }
    setDragOverTabId(tabId);
  },
  []);

  const handleDrop = useCallback(function handleDrop(
    dropTabId: string,
    _event: React.DragEvent,
  ) {
    const dragTabId = dragTabIdRef.current;
    if (dragTabId && dragTabId !== dropTabId) {
      useTabStore.getState().reorderTab(dragTabId, dropTabId);
    }
    dragTabIdRef.current = null;
    setDraggingTabId(null);
    setDragOverTabId(null);
  },
  []);

  const handleDragEnd = useCallback(function handleDragEnd() {
    clearTabDragState();
  }, [clearTabDragState]);

  const handleClearDragOver = useCallback(function handleClearDragOver() {
    setDragOverTabId(null);
  }, []);

  // Drop zone after last tab — allows moving a tab to the end
  const [isEndZoneDragOver, setIsEndZoneDragOver] = useState(false);

  const handleEndZoneDragOver = useCallback(function handleEndZoneDragOver(e: React.DragEvent) {
    if (!dragTabIdRef.current && !hasPanelTitleDrag(e) && !hasPanelNodeDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsEndZoneDragOver(true);
  }, [hasPanelNodeDrag, hasPanelTitleDrag]);

  const handleEndZoneDragLeave = useCallback(function handleEndZoneDragLeave() {
    setIsEndZoneDragOver(false);
  }, []);

  const handleEndZoneDrop = useCallback(function handleEndZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsEndZoneDragOver(false);

    if (handlePanelTitleDropToNewTab(e) || handlePanelNodeDropToNewTab(e)) {
      clearTabDragState();
      return;
    }

    const dragTabId = dragTabIdRef.current;
    if (!dragTabId) return;
    clearTabDragState();

    // Move dragged tab to end (direct splice, not reorderTab which inserts "before")
    useTabStore.setState((state) => {
      const dragIdx = state.tabs.findIndex(t => t.id === dragTabId);
      if (dragIdx === -1 || dragIdx === state.tabs.length - 1) return state;
      const newTabs = [...state.tabs];
      const [draggedTab] = newTabs.splice(dragIdx, 1);
      newTabs.push(draggedTab);
      return { tabs: newTabs };
    });
  }, [clearTabDragState, handlePanelNodeDropToNewTab, handlePanelTitleDropToNewTab]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      role="tablist"
      aria-label={t('chat.tabList')}
      className={cn(
        'flex items-stretch h-9 border-b border-b-(--divider) bg-(--chat-header-bg) shrink-0',
        isWindowsElectron && 'electron-drag h-[40px] bg-(--electron-titlebar-bg) border-b-(--electron-titlebar-border) select-none',
        isWindowsElectron && !gitPanelOpen && 'pr-[152px]',
        isMacElectron && 'electron-drag h-10 border-b-(--chat-header-border) select-none',
        isMacElectron && sidebarCollapsed && 'pl-[84px]'
      )}
      data-testid="tab-bar"
    >
      {/* Sidebar toggle — only visible when left panel is collapsed */}
      {sidebarCollapsed && (
        <button
          className={cn(
            'shrink-0 flex items-center justify-center w-9 h-9 text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--sidebar-hover) transition-colors border-r border-r-(--divider)',
            isWindowsElectron && 'electron-no-drag w-[40px] h-[39px]',
            isMacElectron && 'electron-no-drag w-10 h-10'
          )}
          onClick={toggleSidebar}
          aria-label={t('sidebar.expand')}
          data-testid="tab-bar-sidebar-toggle"
        >
          <PanelLeft size={16} />
        </button>
      )}

      {/* Scrollable tab items container */}
      <div className="relative flex min-w-0 items-stretch">
        <div
          ref={containerRef}
          className="flex min-w-0 items-stretch overflow-x-auto scrollbar-none"
          data-testid="tab-bar-items"
        >
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              isPreview={tab.isPreview}
              isDragOver={tab.id === dragOverTabId}
              isDragging={tab.id === draggingTabId}
              style={{ minWidth: TAB_MIN_WIDTH, maxWidth: TAB_MAX_WIDTH }}
              onActivate={handleTabActivate}
              onClose={handleTabClose}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onClearDragOver={handleClearDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onContextMenu={handleContextMenu}
            />
          ))}
          {/* End drop zone — allows moving a tab to the last position */}
          <div
            className={cn(
              'electron-no-drag shrink-0 w-6 transition-colors',
              isWindowsElectron && 'h-[39px]',
              isEndZoneDragOver && 'border-l-2 border-l-(--accent)',
            )}
            onDragOver={handleEndZoneDragOver}
            onDragLeave={handleEndZoneDragLeave}
            onDrop={handleEndZoneDrop}
            data-testid="tab-bar-end-zone"
          />
        </div>

        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 z-10 w-8 transition-opacity duration-150',
            scrollState.canScrollLeft ? 'opacity-100' : 'opacity-0',
          )}
          style={{ background: 'linear-gradient(to right, var(--chat-header-bg), transparent)' }}
        />
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 z-10 w-8 transition-opacity duration-150',
            scrollState.canScrollRight ? 'opacity-100' : 'opacity-0',
          )}
          style={{ background: 'linear-gradient(to left, var(--chat-header-bg), transparent)' }}
        />

        {scrollState.canScrollLeft && (
          <button
            type="button"
            className="electron-no-drag absolute left-1 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-(--divider) bg-(--chat-header-bg) text-(--text-secondary) shadow-sm transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            onClick={() => handleScrollTabs('left')}
            aria-label="Scroll tabs left"
            data-testid="tab-bar-scroll-left"
          >
            <ChevronLeft size={14} strokeWidth={1.75} />
          </button>
        )}

        {scrollState.canScrollRight && (
          <button
            type="button"
            className="electron-no-drag absolute right-1 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-(--divider) bg-(--chat-header-bg) text-(--text-secondary) shadow-sm transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            onClick={() => handleScrollTabs('right')}
            aria-label="Scroll tabs right"
            data-testid="tab-bar-scroll-right"
          >
            <ChevronRight size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* "+" button — always visible */}
      <ShortcutTooltip id="new-tab" label={t('shortcut.newTab')}>
        <button
          className={cn(
            'shrink-0 flex items-center justify-center w-9 h-9 text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--sidebar-hover) transition-colors',
            isWindowsElectron && 'electron-no-drag w-[40px] h-[39px]',
            isMacElectron && 'electron-no-drag w-10 h-10',
            isCreateTabDragOver && 'bg-(--accent)/14 text-(--accent) shadow-[inset_0_-2px_0_var(--accent)]'
          )}
          onClick={handleAddTab}
          onDragOver={handleCreateTabDragOver}
          onDragLeave={handleCreateTabDragLeave}
          onDrop={handleCreateTabDrop}
          aria-label={t('chat.newTab')}
          data-testid="tab-bar-add"
        >
          <Plus size={16} />
        </button>
      </ShortcutTooltip>

      {/* Spacer — keep this area draggable for frameless Electron windows. */}
      <div
        className={cn(
          'flex-1 transition-colors',
          isCreateTabDragOver && 'bg-(--accent)/10',
        )}
        onDragOver={handleCreateTabDragOver}
        onDragLeave={handleCreateTabDragLeave}
        onDrop={handleCreateTabDrop}
        data-testid="tab-bar-new-tab-drop-zone"
      />

      {/* Right panel toggle — anchored to the right with a clear panel affordance */}
      <button
        className={cn(
          'electron-no-drag shrink-0 flex items-center justify-center w-10 h-9 transition-colors border-l border-l-(--divider)',
          'text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--sidebar-hover)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)',
          isWindowsElectron && 'w-[40px] h-[39px]',
          isMacElectron && 'electron-no-drag w-10 h-10',
          gitPanelOpen
            ? 'bg-(--accent)/14 text-(--accent) shadow-[inset_0_-2px_0_var(--accent)]'
            : 'bg-[color-mix(in_srgb,var(--chat-header-bg)_78%,var(--sidebar-hover))]'
        )}
        onClick={toggleGitPanel}
        aria-label={gitPanelOpen ? t('chat.closeGitPanel') : t('chat.openGitPanel')}
        aria-pressed={gitPanelOpen}
        title={gitPanelOpen ? t('chat.closeGitPanel') : t('chat.openGitPanel')}
        data-testid="tab-bar-git-toggle"
      >
        {gitPanelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>

      {/* Tab context menu */}
      {contextMenu && (() => {
        const tabIdx = tabs.findIndex(t => t.id === contextMenu.tabId);
        return (
          <TabContextMenu
            position={contextMenu.position}
            hasTabsToLeft={tabIdx > 0}
            hasTabsToRight={tabIdx >= 0 && tabIdx < tabs.length - 1}
            hasOtherTabs={tabs.length > 1}
            onClose={handleContextMenuClose}
            onCloseTab={() => handleTabClose(contextMenu.tabId)}
            onCloseOtherTabs={handleCloseOtherTabs}
            onCloseTabsToLeft={handleCloseTabsToLeft}
            onCloseTabsToRight={handleCloseTabsToRight}
            onCloseAllTabs={handleCloseAllTabs}
          />
        );
      })()}
    </div>
  );
});
