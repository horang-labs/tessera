'use client';

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DragEvent,
} from 'react';
import { GripVertical, RotateCcw, Terminal as TerminalIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TabIdContext, usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { useChatStore } from '@/stores/chat-store';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { getInitialTerminalCwd } from '@/lib/terminal/client-terminal-cwd';
import {
  closeAndDisposeTerminalSurface,
  getTerminalSurface,
} from '@/lib/terminal/terminal-surface-registry';
import { setPanelNodeDragData } from '@/lib/dnd/panel-session-drag';
import { useIsDark } from '@/hooks/use-is-dark';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';

interface TerminalPanelProps {
  panelId: string;
  terminalId: string;
  terminalSessionId: string | null;
  /** Terminal-mode sessions own their PTY independently from this React mount. */
  sessionOwned?: boolean;
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
  sessionOwned = false,
  launch,
}: TerminalPanelProps) {
  const tabId = useContext(TabIdContext);
  const isDark = useIsDark();
  const containerRef = useRef<HTMLDivElement>(null);
  const assignTerminal = usePanelStore((state) => state.assignTerminal);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const isTabActive = useTabStore((state) => state.activeTabId === tabId);
  const isPanelActive = usePanelStore((state) => (
    state.activeTabId === tabId && state.tabPanels[tabId]?.activePanelId === panelId
  ));
  const surface = useMemo(() => getTerminalSurface({
    registryKey: `${tabId}:${panelId}:${terminalId}`,
    terminalId,
    cwd: getInitialTerminalCwd(terminalSessionId),
    sessionId: getSessionSelectionId(terminalSessionId),
    launch,
  }), [launch, panelId, tabId, terminalId, terminalSessionId]);
  const { status, subtitle } = useSyncExternalStore(
    surface.subscribe,
    surface.getSnapshot,
    surface.getSnapshot,
  );
  const terminalTheme = getTerminalTheme(isDark);

  useEffect(() => {
    surface.setTheme(getTerminalTheme(isDark));
  }, [isDark, surface]);

  const handlePanelDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    const didSet = setPanelNodeDragData(event.dataTransfer, { tabId, panelId });
    if (!didSet) event.preventDefault();
  }, [panelId, tabId]);

  const handleTerminalAction = useCallback(() => {
    if (status === 'exited' || status === 'error') {
      void surface.restart();
      return;
    }

    if (sessionOwned) {
      surface.close();
      return;
    }

    closeAndDisposeTerminalSurface(surface);
    assignTerminal(panelId, null);
  }, [assignTerminal, panelId, sessionOwned, status, surface]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    void surface.mount(host);
    return () => {
      surface.unmount(host);
      // Moving a panel can transiently unmount it. Check ownership after the
      // store update settles. A moved surface detaches; an actually removed
      // standalone terminal is the only case that kills the PTY.
      setTimeout(() => {
        const remainsInSamePanel = isTerminalAssignedToPanel(
          tabId,
          panelId,
          terminalId,
          terminalSessionId,
          sessionOwned,
        );
        if (remainsInSamePanel && useTabStore.getState().lruTabIds.includes(tabId)) return;

        // LRU eviction removes the React tree while retaining panel ownership.
        // Release the xterm/subscriber but keep the server PTY for cold attach.
        if (remainsInSamePanel) {
          surface.dispose();
          return;
        }

        if (sessionOwned || isTerminalAssignedToAnyPanel(terminalId)) {
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
        <div ref={containerRef} className="h-full min-h-0 overflow-hidden" />
        {sessionOwned && status !== 'running' && (
          <div
            role="status"
            data-testid={canRestart
              ? 'terminal-session-restart-banner'
              : 'terminal-session-status-banner'}
            className="pointer-events-none absolute inset-x-3 top-3 flex justify-center"
          >
            <div className="pointer-events-auto flex max-w-full items-center gap-3 border border-(--divider) bg-(--chat-header-bg) px-3 py-2 text-xs text-(--text-secondary)">
              <span className="min-w-0 truncate">{subtitle}</span>
              {canRestart && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2"
                  onClick={handleTerminalAction}
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
