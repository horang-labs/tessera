"use client";

import { useSessionStore } from "@/stores/session-store";
import { useNotificationStore } from "@/stores/notification-store";
import {
  BOARD_SIDEBAR_DEFAULT_WIDTH,
  BOARD_SIDEBAR_MIN_WIDTH,
  LIST_SIDEBAR_DEFAULT_WIDTH,
  LIST_SIDEBAR_MIN_WIDTH,
  useSettingsStore,
} from "@/stores/settings-store";
import { useBoardStore } from "@/stores/board-store";
import { useWebSocket } from "@/hooks/use-websocket";
import { useCrossWindowUiSync } from "@/hooks/use-cross-window-ui-sync";
import { useResize } from "@/hooks/use-resize";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { KeyboardShortcutProvider } from "@/components/keyboard/keyboard-shortcut-provider";

const loadSettingsPanel = () => import("@/components/settings/settings-panel");
const SettingsPanel = dynamic(
  loadSettingsPanel,
  { ssr: false },
);
const ToastContainer = dynamic(
  () => import("@/components/notifications/toast-container").then((m) => m.ToastContainer),
  { ssr: false },
);
const UpdateNotifier = dynamic(
  () => import("@/components/update/update-notifier").then((m) => m.UpdateNotifier),
  { ssr: false },
);
import { SelectionActionBar } from "./selection-action-bar";
import { usePanelStore, selectActiveTab } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import { TabBar } from "@/components/tab/tab-bar";
import { TabPanelHost } from "@/components/tab/tab-panel-host";
import { ElectronTitlebarThemeSync } from "@/components/layout/electron-titlebar";
import { TabCarouselNav } from "@/components/tab/tab-carousel-nav";
import { LeftPanel } from "./left-panel";
const GitPanel = dynamic(
  () => import("@/components/git/git-panel").then((m) => m.GitPanel),
  { ssr: false },
);
import { useGitStore } from "@/stores/git-store";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { ALL_PROJECTS_SENTINEL } from "@/lib/constants/project-strip";
import {
  getSpecialSessionSourceSessionId,
  isSpecialSession,
} from "@/lib/constants/special-sessions";

const SIDEBAR_RESIZE_HANDLE_WIDTH = 1;
const GIT_PANEL_RESIZE_HANDLE_WIDTH = 1;
const RIGHT_AREA_MIN_WIDTH = 360;
const COMPACT_RIGHT_AREA_MIN_WIDTH = 240;
const COMPACT_VIEWPORT_BREAKPOINT = 1024;
const FALLBACK_VIEWPORT_WIDTH = 1440;
const KANBAN_SCROLL_AREA_SELECTOR = '[data-kanban-scroll-area="true"]';
const KANBAN_SCROLL_END_SNAP_THRESHOLD = 16;

function getViewportWidth(): number {
  return typeof window === "undefined"
    ? FALLBACK_VIEWPORT_WIDTH
    : window.innerWidth;
}

function getSidebarMaxWidth(
  viewportWidth: number,
  gitPanelOpen: boolean,
  gitPanelWidth: number,
): number {
  const rightAreaMinWidth =
    viewportWidth < COMPACT_VIEWPORT_BREAKPOINT
      ? COMPACT_RIGHT_AREA_MIN_WIDTH
      : RIGHT_AREA_MIN_WIDTH;
  const ratioMaxWidth = Math.floor(viewportWidth * 0.8);
  const gitPanelReserved = gitPanelOpen
    ? gitPanelWidth + GIT_PANEL_RESIZE_HANDLE_WIDTH
    : 0;
  const reservedRightMaxWidth =
    viewportWidth -
    rightAreaMinWidth -
    SIDEBAR_RESIZE_HANDLE_WIDTH -
    gitPanelReserved;
  return Math.max(0, Math.min(ratioMaxWidth, reservedRightMaxWidth));
}

function getKanbanScrollArea(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLDivElement>(KANBAN_SCROLL_AREA_SELECTOR);
}

export function ChatLayout() {
  const { t } = useI18n();
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const activeGitSessionId = activeSessionId
    ? getSpecialSessionSourceSessionId(activeSessionId)
      ?? (isSpecialSession(activeSessionId) ? null : activeSessionId)
    : null;

  // BR-PERSIST-002: tabs + activeTabId as persist effect dependencies
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const markSessionAsRead = useNotificationStore(
    (state) => state.markSessionAsRead,
  );
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const viewMode = useBoardStore((state) => state.viewMode);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const sidebarWidth = useSettingsStore(
    (state) => state.getSidebarWidth(viewMode, selectedProjectDir),
  );
  const loadSettings = useSettingsStore((state) => state.load);
  const setSidebarCollapsed = useSettingsStore(
    (state) => state.setSidebarCollapsed,
  );
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth);
  const projects = useSessionStore((state) => state.projects);
  const gitPanelOpen = useGitStore((state) => state.isOpen);
  const gitPanelWidth = useGitStore((state) => state.panelWidth);
  const setGitPanelWidth = useGitStore((state) => state.setPanelWidth);
  useWebSocket(); // Initialize WebSocket connection
  useCrossWindowUiSync(); // Mirror activeSessionId / selectedProjectDir to popouts

  // BR-PERSIST-001: persistLayout debounce ref (200ms)
  const persistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kanbanScrollAnchorRef = useRef<{ rightEdge: number; atEnd: boolean } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth);
  const initiallyHasProjects = projects.length > 0;
  const projectsLoadedRef = useRef(initiallyHasProjects);
  const [projectsLoaded, setProjectsLoaded] = useState(initiallyHasProjects);

  const sidebarBaseMinWidth =
    viewMode === "board" ? BOARD_SIDEBAR_MIN_WIDTH : LIST_SIDEBAR_MIN_WIDTH;
  const sidebarMaxWidth = getSidebarMaxWidth(
    viewportWidth,
    gitPanelOpen,
    gitPanelWidth,
  );
  const sidebarMinWidth = Math.min(sidebarBaseMinWidth, sidebarMaxWidth);
  const effectiveSidebarWidth = Math.min(
    Math.max(sidebarWidth, sidebarMinWidth),
    sidebarMaxWidth,
  );

  useEffect(function loadUserSettings() {
    void loadSettings();
  }, [loadSettings]);

  useEffect(function preloadElectronSettingsPanel() {
    if (typeof window === "undefined") return;

    const electronApi = (window as Window & { electronAPI?: { isElectron?: boolean } }).electronAPI;
    if (!electronApi?.isElectron) return;

    const preload = () => {
      void loadSettingsPanel();
    };

    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preload, { timeout: 2000 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preload, 1000);
    return () => globalThis.clearTimeout(timeoutId);
  }, []);

  const captureKanbanScrollAnchor = useCallback(() => {
    const scrollArea = getKanbanScrollArea();
    if (!scrollArea || scrollArea.scrollLeft <= 1) {
      kanbanScrollAnchorRef.current = null;
      return;
    }

    const rightEdge = scrollArea.scrollLeft + scrollArea.clientWidth;
    const atEnd =
      scrollArea.scrollWidth - rightEdge <= KANBAN_SCROLL_END_SNAP_THRESHOLD;
    kanbanScrollAnchorRef.current = {
      rightEdge: atEnd ? scrollArea.scrollWidth : rightEdge,
      atEnd,
    };
  }, []);

  const restoreKanbanScrollAnchor = useCallback(() => {
    const anchor = kanbanScrollAnchorRef.current;
    if (!anchor) return;

    requestAnimationFrame(() => {
      const scrollArea = getKanbanScrollArea();
      if (!scrollArea) return;

      const rightEdge = anchor.atEnd ? scrollArea.scrollWidth : anchor.rightEdge;
      const maxScrollLeft = Math.max(0, scrollArea.scrollWidth - scrollArea.clientWidth);
      scrollArea.scrollLeft = Math.max(
        0,
        Math.min(maxScrollLeft, rightEdge - scrollArea.clientWidth),
      );
    });
  }, []);

  const handleSidebarWidthChange = useCallback(
    (width: number) => {
      setSidebarWidth(width, viewMode, selectedProjectDir);
      restoreKanbanScrollAnchor();
    },
    [restoreKanbanScrollAnchor, selectedProjectDir, setSidebarWidth, viewMode],
  );

  // REQ-002: Drag-to-resize hook
  const {
    isDragging: isSidebarDragging,
    handleMouseDown,
    handleDoubleClick,
  } = useResize({
    defaultWidth:
      viewMode === "board"
        ? BOARD_SIDEBAR_DEFAULT_WIDTH
        : LIST_SIDEBAR_DEFAULT_WIDTH,
    minWidth: sidebarMinWidth,
    maxWidth: sidebarMaxWidth,
    onWidthChange: handleSidebarWidthChange,
  });

  const handleSidebarResizeMouseDown = useCallback(
    (event: React.MouseEvent) => {
      captureKanbanScrollAnchor();
      handleMouseDown(event);
    },
    [captureKanbanScrollAnchor, handleMouseDown],
  );

  const handleSidebarResizeDoubleClick = useCallback(() => {
    captureKanbanScrollAnchor();
    handleDoubleClick();
    restoreKanbanScrollAnchor();
  }, [captureKanbanScrollAnchor, handleDoubleClick, restoreKanbanScrollAnchor]);

  const {
    isDragging: isGitDragging,
    handleMouseDown: handleGitMouseDown,
    handleDoubleClick: handleGitDoubleClick,
  } = useResize({
    defaultWidth: 320,
    minWidth: 240,
    maxWidth:
      typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.5) : 800,
    onWidthChange: setGitPanelWidth,
    direction: "left",
  });

  // BR-INIT-001: 앱 마운트 시 tab-store에서 탭+패널 상태 복원
  useEffect(function restoreTabState() {
    try {
      useTabStore.getState().restoreFromLocalStorage();
    } catch (e) {
      console.warn(
        "[ChatLayout] restoreFromLocalStorage() threw unexpectedly:",
        e,
      );
    }
  }, []);

  // Load projects on mount (viewMode-agnostic — ensures board view has data too)
  useEffect(function loadProjects() {
    let cancelled = false;

    void Promise.resolve(useSessionStore.getState().loadProjects()).finally(() => {
      if (!cancelled && !projectsLoadedRef.current) {
        projectsLoadedRef.current = true;
        setProjectsLoaded(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-initialize selectedProjectDir when projects load
  useEffect(
    function initSelectedProject() {
      if (!projectsLoaded) return;

      const current = useBoardStore.getState().selectedProjectDir;
      if (projects.length === 0) {
        if (current !== ALL_PROJECTS_SENTINEL) {
          useBoardStore.getState().setSelectedProjectDir(ALL_PROJECTS_SENTINEL);
        }
        return;
      }

      if (current === null) {
        const restoredProjectDir = useTabStore.getState().currentProjectDir;
        if (restoredProjectDir === ALL_PROJECTS_SENTINEL) {
          useBoardStore.getState().setSelectedProjectDir(restoredProjectDir);
          return;
        }
        if (restoredProjectDir && projects.some((p) => p.encodedDir === restoredProjectDir)) {
          useBoardStore.getState().setSelectedProjectDir(restoredProjectDir);
          return;
        }
        const proj = projects.find((p) => p.isCurrent) ?? projects[0];
        useBoardStore.getState().setSelectedProjectDir(proj.encodedDir);
      } else if (current === ALL_PROJECTS_SENTINEL) {
        return; // All Projects mode is always valid
      } else {
        const stillExists = projects.some((p) => p.encodedDir === current);
        if (!stillExists) {
          const proj = projects.find((p) => p.isCurrent) ?? projects[0];
          useBoardStore.getState().setSelectedProjectDir(proj.encodedDir);
        }
      }
    },
    [projects, projectsLoaded],
  );

  // Bridge Effect: sync selectedProjectDir from board-store → tab-store project scope
  useEffect(
    function bridgeProjectSwitchToTabs() {
      if (selectedProjectDir === null) return;
      useTabStore.getState().switchProject(selectedProjectDir);
    },
    [selectedProjectDir],
  );

  // BR-PERSIST-001/002/003: debounced tab state persistence (200ms)
  useEffect(
    function persistTabState() {
      clearTimeout(persistDebounceRef.current ?? undefined);
      persistDebounceRef.current = setTimeout(function debouncedPersist() {
        useTabStore.getState().persistToLocalStorage();
      }, 200);

      return function clearPersistDebounce() {
        clearTimeout(persistDebounceRef.current ?? undefined);
      };
    },
    [tabs, activeTabId],
  );

  useEffect(() => {
    if (activeSessionId && !isSpecialSession(activeSessionId)) {
      markSessionAsRead(activeSessionId);
    }
  }, [activeSessionId, markSessionAsRead]);

  // Bridge Effect: sync activeSessionId from session-store → panel-store.
  useEffect(
    function bridgeActiveSessionToPanel() {
      if (!activeSessionId) return;

      const panelState = usePanelStore.getState();
      const activeTabData = selectActiveTab(panelState);

      const currentPanelSessionId =
        activeTabData?.panels[activeTabData.activePanelId]?.sessionId ?? null;
      if (activeSessionId === currentPanelSessionId) {
        useTabStore.getState().syncTabProjectFromSession(panelState.activeTabId, activeSessionId);
        return;
      }

      let location: { tabId: string; panelId: string } | null = null;
      try {
        location = useTabStore.getState().findSessionLocation(activeSessionId);
      } catch {
        return;
      }
      if (location !== null) return;

      panelState.assignSession(activeTabData?.activePanelId ?? '', activeSessionId);
      useTabStore.getState().syncTabProjectFromSession(panelState.activeTabId, activeSessionId);
    },
    [activeSessionId],
  );

  // When the last popout board window closes, refresh tasks/collections in the
  // main window so changes made in the popout become visible.
  useEffect(function reloadBoardOnPopoutClose() {
    if (typeof window === 'undefined') return;
    const electronApi = (window as Window & {
      electronAPI?: {
        isElectron?: boolean;
        onPopoutStateChanged?: (cb: (count: number) => void) => (() => void) | void;
      };
    }).electronAPI;
    if (!electronApi?.isElectron || !electronApi.onPopoutStateChanged) return;

    let prev = 0;
    const cleanup = electronApi.onPopoutStateChanged(async (next) => {
      const wasActive = prev > 0;
      prev = next;
      if (!wasActive || next !== 0) return;
      try {
        const { reloadBoardData } = await import('@/hooks/use-popout-active');
        await reloadBoardData();
      } catch (err) {
        console.warn('[ChatLayout] popout reload failed:', err);
      }
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // Listen for session-open requests forwarded from popout board windows.
  useEffect(function listenForPopoutOpenSession() {
    if (typeof window === 'undefined') return;
    const electronApi = (window as Window & {
      electronAPI?: {
        isElectron?: boolean;
        onPopoutOpenSession?: (
          cb: (payload: { sessionId: string; action: 'preview' | 'pin' }) => void
        ) => (() => void) | void;
      };
    }).electronAPI;
    if (!electronApi?.isElectron || !electronApi.onPopoutOpenSession) return;
    const cleanup = electronApi.onPopoutOpenSession(({ sessionId, action }) => {
      if (!sessionId) return;
      const tabStore = useTabStore.getState();
      const location = tabStore.findSessionLocation(sessionId);
      if (action === 'pin') {
        if (location) {
          tabStore.setActiveTab(location.tabId);
          usePanelStore.getState().setActivePanelId(location.panelId);
          tabStore.pinTab(location.tabId);
        } else {
          tabStore.createTabWithSession(sessionId);
        }
      } else if (location) {
        tabStore.setActiveTab(location.tabId);
        usePanelStore.getState().setActivePanelId(location.panelId);
      } else {
        tabStore.openPreview(sessionId);
      }
      useSessionStore.getState().setActiveSession(sessionId);
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // BR-TOGGLE-005: 반응형 강제 collapsed (<1024px)
  useEffect(() => {
    const handleResize = () => {
      const nextViewportWidth = window.innerWidth;
      setViewportWidth((current) =>
        current === nextViewportWidth ? current : nextViewportWidth,
      );
      if (nextViewportWidth < COMPACT_VIEWPORT_BREAKPOINT) {
        setSidebarCollapsed(true);
      }
    };

    handleResize();

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [setSidebarCollapsed]);

  return (
    <KeyboardShortcutProvider>
      <ElectronTitlebarThemeSync />
      <div className="flex h-screen flex-col overflow-hidden" data-testid="chat-layout">
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel — project strip + header + content (list/kanban) */}
          {!sidebarCollapsed && (
            <>
              <LeftPanel width={effectiveSidebarWidth} />
              {/* Resize handle */}
              <div
                className={cn(
                  "relative z-10 shrink-0 w-px h-full bg-transparent cursor-col-resize transition-all duration-150",
                  isSidebarDragging
                    ? "bg-(--accent) shadow-[0_0_6px_var(--accent)]"
                    : "hover:bg-(--accent) hover:shadow-[0_0_4px_var(--accent)]",
                )}
                onMouseDown={handleSidebarResizeMouseDown}
                onDoubleClick={handleSidebarResizeDoubleClick}
                role="separator"
                aria-label={t("sidebar.resizeHandle")}
                data-testid="sidebar-resize-handle"
              >
                <div className="absolute inset-y-0 -left-[11px] w-[24px] cursor-col-resize" />
              </div>
            </>
          )}

          {/* Right area — TabBar + Carousel + TabPanelHost (always visible) */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <TabBar />
            <TabCarouselNav>
              <TabPanelHost />
            </TabCarouselNav>
            {/* Portal target for the Git diff drawer (rendered by GitPanel) */}
            <div id="git-diff-drawer-portal" />
          </div>

          {/* Git Panel + Resize Handle */}
          {gitPanelOpen && (
            <>
              <div
                className={cn(
                  "relative z-10 shrink-0 w-1 h-full cursor-col-resize flex items-center justify-center transition-all duration-150",
                  isGitDragging
                    ? "[&>div]:bg-(--accent) [&>div]:shadow-[0_0_6px_var(--accent)]"
                    : "hover:[&>div]:bg-(--accent) hover:[&>div]:shadow-[0_0_4px_var(--accent)]",
                )}
                onMouseDown={handleGitMouseDown}
                onDoubleClick={handleGitDoubleClick}
                role="separator"
                aria-label="Git panel resize handle"
                data-testid="git-panel-resize-handle"
              >
                <div className="pointer-events-none transition-all duration-150 bg-(--divider) w-px h-full" />
              </div>
              <GitPanel sessionId={activeGitSessionId} width={gitPanelWidth} />
            </>
          )}
        </div>
      </div>
      <SettingsPanel />
      <ToastContainer />
      <UpdateNotifier />
      <SelectionActionBar />
    </KeyboardShortcutProvider>
  );
}
