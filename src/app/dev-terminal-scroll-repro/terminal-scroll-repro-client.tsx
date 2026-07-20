'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollToBottomButton } from '@/components/ui/scroll-to-bottom-button';
import { useIsDark } from '@/hooks/use-is-dark';
import {
  closeAndDisposeTerminalSurface,
  getTerminalSurface,
  type TerminalSurfaceSnapshot,
} from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import { useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getTerminalFontSize } from '@/lib/terminal/terminal-font-size';
import { TerminalScrollbar } from '@/components/terminal/terminal-scrollbar';

const REPRO_TERMINAL_ID = 'dev-terminal-scroll-repro';
const INITIAL_SNAPSHOT: TerminalSurfaceSnapshot = {
  status: 'starting',
  subtitle: 'Starting terminal...',
  isAtBottom: true,
  scrollMetrics: { baseY: 0, viewportY: 0, rows: 1 },
};

interface ReproTerminalBuffer {
  baseY: number;
  viewportY: number;
  getLine(line: number): { translateToString(trimRight?: boolean): string } | undefined;
}

interface ReproWindow extends Window {
  __tesseraTerminalScrollRepro?: {
    firstVisibleRowTag(): string | null;
    isAtBottom(): boolean | null;
    viewportY(): number | null;
  };
}

export function TerminalScrollReproClient() {
  const isDark = useIsDark();
  const fontScale = useSettingsStore((state) => state.settings.fontSize);
  const terminalFontSize = getTerminalFontSize(fontScale);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const hostRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true);
  const surface = useMemo(() => getTerminalSurface({
    registryKey: REPRO_TERMINAL_ID,
    terminalId: REPRO_TERMINAL_ID,
    theme: getTerminalTheme(isDark),
    fontSize: terminalFontSize,
    cwd: null,
    sessionId: null,
  }), [isDark, terminalFontSize]);
  const snapshot = useSyncExternalStore(
    surface.subscribe,
    surface.getSnapshot,
    () => INITIAL_SNAPSHOT,
  );

  useEffect(() => {
    wsClient.connect('terminal-scroll-repro');
  }, []);

  useEffect(() => {
    surface.setTheme(getTerminalTheme(isDark));
  }, [isDark, surface]);

  useEffect(() => {
    surface.setFontSize(terminalFontSize);
  }, [surface, terminalFontSize]);

  useEffect(() => {
    const reproWindow = window as ReproWindow;
    reproWindow.__tesseraTerminalScrollRepro = {
      firstVisibleRowTag: () => {
        const terminal = (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer }; rows: number } | null;
        }).terminal;
        if (!terminal) return null;
        const { active } = terminal.buffer;
        for (let offset = 0; offset < terminal.rows; offset += 1) {
          const text = active.getLine(active.viewportY + offset)?.translateToString(true) ?? '';
          const match = text.match(/ROW_(\d{4})/);
          if (match) return match[1];
        }
        return null;
      },
      isAtBottom: () => {
        const active = (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer } } | null;
        }).terminal?.buffer.active;
        return active ? active.viewportY >= active.baseY - 1 : null;
      },
      viewportY: () => (
        (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer } } | null;
        }).terminal?.buffer.active.viewportY ?? null
      ),
    };
    return () => {
      delete reproWindow.__tesseraTerminalScrollRepro;
    };
  }, [surface]);

  useEffect(() => {
    const host = hostRef.current;
    if (!isVisible || !host) return;
    void surface.mount(host);
    return () => surface.unmount(host);
  }, [isVisible, surface]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !isVisible) return;
    void surface.ensureConnected().then((connected) => {
      if (connected) surface.activate();
    });
  }, [connectionStatus, isVisible, surface]);

  const theme = getTerminalTheme(isDark);

  return (
    <main className="flex h-screen flex-col bg-(--chat-bg) text-(--text-primary)">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--divider) px-4 text-xs">
        <span data-testid="terminal-repro-status">{snapshot.status}</span>
        <button
          type="button"
          className="rounded border border-(--divider) px-2 py-1"
          data-testid="toggle-terminal-view"
          onClick={() => setIsVisible((current) => !current)}
        >
          {isVisible ? 'Hide terminal' : 'Show terminal'}
        </button>
        <button
          type="button"
          className="rounded border border-(--divider) px-2 py-1"
          data-testid="close-terminal-repro"
          onClick={() => closeAndDisposeTerminalSurface(surface)}
        >
          Close terminal
        </button>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        data-testid="terminal-scroll-repro"
        style={{ backgroundColor: theme.background, color: theme.foreground }}
      >
        {isVisible && (
          <div className="flex h-full min-h-0 gap-1">
            <div ref={hostRef} className="h-full min-w-0 flex-1 overflow-hidden" />
            <TerminalScrollbar metrics={snapshot.scrollMetrics} />
          </div>
        )}
        {!snapshot.isAtBottom && (
          <ScrollToBottomButton
            onClick={() => surface.scrollToBottom()}
            title="Scroll to bottom"
            testId="terminal-scroll-to-bottom-button"
          />
        )}
      </div>
    </main>
  );
}
