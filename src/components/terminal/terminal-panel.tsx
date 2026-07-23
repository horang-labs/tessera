'use client';

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, RotateCcw, Terminal as TerminalIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollToBottomButton } from '@/components/ui/scroll-to-bottom-button';
import { TabIdContext, usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { getInitialTerminalCwd } from '@/lib/terminal/client-terminal-cwd';
import {
  closeAndDisposeTerminalSurface,
  getTerminalSurface,
} from '@/lib/terminal/terminal-surface-registry';
import { setPanelNodeDragData } from '@/lib/dnd/panel-session-drag';
import { useIsDark } from '@/hooks/use-is-dark';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { getTerminalFontSize } from '@/lib/terminal/terminal-font-size';
import { registerTerminalPreviewSurface } from '@/lib/terminal/terminal-preview-surface-lifecycle';

interface TerminalPanelProps {
  panelId: string;
  terminalId: string;
  terminalSessionId: string | null;
  /** Determines whether unmount detaches, or may close a preview-created PTY. */
  runtimeOwnership?: 'standalone' | 'session-preview' | 'session-retained' | 'session-peek';
  /** Treat a transient surface as visible/focused without borrowing panel-store state. */
  surfaceActive?: boolean;
  /** Optional overlay shown until the terminal surface reports that it is running. */
  startupOverlay?: ReactNode;
  launch?: { providerId: string; sessionId: string };
}

function isTerminalAssignedToPanel(
  tabId: string,
  panelId: string,
  terminalId: string,
  terminalSessionId: string | null,
  sessionOwned: boolean,
): boolean {
  const panel = usePanelStore.getState().tabPanels[tabId]?.panels[panelId];
  return sessionOwned
    ? panel?.sessionId === terminalSessionId
    : panel?.terminalId === terminalId;
}

function isTerminalAssignedToAnyPanel(terminalId: string): boolean {
  const { tabPanels } = usePanelStore.getState();
  return Object.values(tabPanels).some((tabData) =>
    Object.values(tabData.panels).some((panel) => panel.terminalId === terminalId),
  );
}

export function TerminalPanel({
  panelId,
  terminalId,
  terminalSessionId,
  runtimeOwnership = 'standalone',
  surfaceActive = false,
  startupOverlay,
  launch,
}: TerminalPanelProps) {
  const tabId = useContext(TabIdContext);
  const { t } = useTranslation();
  const isDark = useIsDark();
  const fontScale = useSettingsStore((state) => state.settings.fontSize);
  const lightThemePreset = useSettingsStore((state) => state.settings.terminalThemeLightPreset);
  const darkThemePreset = useSettingsStore((state) => state.settings.terminalThemeDarkPreset);
  const selectedThemePreset = isDark ? darkThemePreset : lightThemePreset;
  const terminalFontSize = getTerminalFontSize(fontScale);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingSurfaceCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assignTerminal = usePanelStore((state) => state.assignTerminal);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const sessionOwned = runtimeOwnership !== 'standalone';
  const previewOwnsRuntimeRef = useRef(runtimeOwnership === 'session-preview');
  const handleTerminalInput = useCallback(() => {
    if (runtimeOwnership === 'standalone' || runtimeOwnership === 'session-peek') return;
    previewOwnsRuntimeRef.current = false;
    useTabStore.getState().pinTab(tabId);
  }, [runtimeOwnership, tabId]);
  const isTabActive = useTabStore((state) => surfaceActive || state.activeTabId === tabId);
  const isPanelActive = usePanelStore((state) => (
    surfaceActive
    || (state.activeTabId === tabId && state.tabPanels[tabId]?.activePanelId === panelId)
  ));
  const surface = useMemo(() => getTerminalSurface({
    registryKey: `${tabId}:${panelId}:${terminalId}`,
    terminalId,
    theme: getTerminalTheme(isDark, selectedThemePreset),
    appearanceMode: isDark ? 'dark' : 'light',
    fontSize: terminalFontSize,
    cwd: getInitialTerminalCwd(terminalSessionId),
    sessionId: getSessionSelectionId(terminalSessionId),
    launch,
    previewOwned: runtimeOwnership === 'session-preview',
  }), [
    isDark,
    launch,
    panelId,
    runtimeOwnership,
    selectedThemePreset,
    tabId,
    terminalFontSize,
    terminalId,
    terminalSessionId,
  ]);
  const {
    status,
    subtitle,
    isAtBottom,
    appearanceMode,
    themeRestartRequired,
    themeRestartAllowed,
  } = useSyncExternalStore(
    surface.subscribe,
    surface.getSnapshot,
    surface.getSnapshot,
  );
  const terminalTheme = getTerminalTheme(
    appearanceMode === 'dark',
    appearanceMode === 'dark' ? darkThemePreset : lightThemePreset,
  );

  useEffect(() => {
    surface.setTheme(
      getTerminalTheme(isDark, selectedThemePreset),
      isDark ? 'dark' : 'light',
    );
  }, [isDark, selectedThemePreset, surface]);

  useEffect(() => {
    surface.setHostVisible(isTabActive);
  }, [isTabActive, surface]);

  useEffect(() => {
    surface.setFontSize(terminalFontSize);
  }, [surface, terminalFontSize]);

  useEffect(() => {
    surface.setInputListener(handleTerminalInput);
    return () => surface.setInputListener(null);
  }, [handleTerminalInput, surface]);

  useEffect(() => {
    if (runtimeOwnership !== 'session-preview') previewOwnsRuntimeRef.current = false;
  }, [runtimeOwnership]);

  useEffect(() => {
    if (runtimeOwnership === 'session-preview' && terminalSessionId) {
      registerTerminalPreviewSurface(terminalSessionId, surface);
    }
  }, [runtimeOwnership, surface, terminalSessionId]);

  const handlePanelDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    const didSet = setPanelNodeDragData(event.dataTransfer, { tabId, panelId });
    if (!didSet) event.preventDefault();
  }, [panelId, tabId]);

  const handleTerminalAction = useCallback(() => {
    if (status === 'exited' || status === 'error') {
      if (sessionOwned) handleTerminalInput();
      void surface.restart();
      return;
    }

    if (sessionOwned) {
      surface.close();
      return;
    }

    closeAndDisposeTerminalSurface(surface);
    assignTerminal(panelId, null);
  }, [assignTerminal, handleTerminalInput, panelId, sessionOwned, status, surface]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    if (pendingSurfaceCleanupRef.current !== null) {
      clearTimeout(pendingSurfaceCleanupRef.current);
      pendingSurfaceCleanupRef.current = null;
    }

    void surface.mount(host);
    return () => {
      surface.unmount(host);
      // Moving a panel can transiently unmount it. Check ownership after the
      // store update settles. A moved surface detaches; an actually removed
      // standalone terminal is the only case that kills the PTY.
      pendingSurfaceCleanupRef.current = setTimeout(() => {
        pendingSurfaceCleanupRef.current = null;
        const remainsInSamePanel = isTerminalAssignedToPanel(
          tabId,
          panelId,
          terminalId,
          terminalSessionId,
          sessionOwned,
        );
        if (remainsInSamePanel && useTabStore.getState().lruTabIds.includes(tabId)) return;

        // LRU eviction removes the React tree while retaining panel ownership.
        // A preview-owned surface stays registered so replacing the unmounted
        // preview can still close the runtime it created. Retained sessions use
        // the normal cold-attach path.
        if (remainsInSamePanel) {
          if (sessionOwned && previewOwnsRuntimeRef.current) return;
          surface.dispose();
          return;
        }

        if (sessionOwned && previewOwnsRuntimeRef.current) {
          surface.releasePreviewRuntime();
        } else if (sessionOwned || isTerminalAssignedToAnyPanel(terminalId)) {
          surface.dispose();
        } else {
          closeAndDisposeTerminalSurface(surface);
        }
      }, 0);
    };
  }, [panelId, sessionOwned, surface, tabId, terminalId, terminalSessionId]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !isTabActive) return;
    void surface.ensureConnected().then((connected) => {
      if (connected && isPanelActive) surface.activate();
    });
  }, [connectionStatus, isPanelActive, isTabActive, surface]);

  const canRestart = status === 'exited' || status === 'error';
  const handleThemeRestart = useCallback(() => {
    surface.restartForTheme();
  }, [surface]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="terminal-panel"
      style={{ backgroundColor: terminalTheme.background, color: terminalTheme.foreground }}
    >
      {!sessionOwned && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/10 px-2 text-xs dark:border-white/10">
          <button
            type="button"
            draggable
            onDragStart={handlePanelDragStart}
            title="Move terminal panel"
            aria-label="Move terminal panel"
            data-testid="terminal-panel-drag-handle"
            className="cursor-grab rounded p-1 text-black/60 transition-colors hover:bg-black/5 hover:text-black active:cursor-grabbing dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <TerminalIcon className="h-4 w-4 text-(--accent)" />
          <div className="flex min-w-0 shrink items-center gap-2 select-text">
            <span className="font-medium">Terminal</span>
            <span className="min-w-0 truncate text-black/60 dark:text-white/60">{subtitle}</span>
          </div>
          <div
            draggable
            onDragStart={handlePanelDragStart}
            title="Move terminal panel"
            aria-label="Move terminal panel"
            data-testid="terminal-panel-empty-drag-region"
            className="h-full min-w-8 flex-1 cursor-grab active:cursor-grabbing"
          />
          <span className="text-black/60 dark:text-white/60">{status}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={handleTerminalAction}
            aria-label={canRestart ? 'Restart terminal' : 'Close terminal'}
            title={canRestart ? 'Restart terminal' : 'Close terminal'}
          >
            {canRestart ? <RotateCcw className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div ref={containerRef} className="h-full min-w-0 overflow-hidden" />
        {status === 'starting' && startupOverlay ? (
          <div className="absolute inset-0 z-10">{startupOverlay}</div>
        ) : null}
        {!isAtBottom && (
          <ScrollToBottomButton
            onClick={() => surface.scrollToBottom()}
            title={t('chat.scrollToBottom')}
            testId="terminal-scroll-to-bottom-button"
          />
        )}
        {(themeRestartRequired || (sessionOwned && status !== 'running')) && (
          <div
            role="status"
            data-testid={themeRestartRequired
              ? 'terminal-theme-restart-banner'
              : canRestart
                ? 'terminal-session-restart-banner'
                : 'terminal-session-status-banner'}
            className="pointer-events-none absolute inset-x-3 top-3 flex justify-center"
          >
            <div className="pointer-events-auto flex max-w-full items-center gap-3 border border-(--divider) bg-(--chat-header-bg) px-3 py-2 text-xs text-(--text-secondary)">
              <span className="min-w-0 truncate">
                {themeRestartRequired
                  ? themeRestartAllowed
                    ? 'Restart to apply the new terminal theme.'
                    : 'This running terminal keeps its launch theme to prevent mixed CLI colors.'
                  : subtitle}
              </span>
              {(canRestart || (themeRestartRequired && themeRestartAllowed)) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2"
                  onClick={themeRestartRequired ? handleThemeRestart : handleTerminalAction}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restart
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
