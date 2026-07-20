'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollToBottomButton } from '@/components/ui/scroll-to-bottom-button';
import { PanelDivider } from '@/components/panel/panel-divider';
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

const REPRO_TERMINAL_ID = 'dev-terminal-scroll-repro';
const INITIAL_SNAPSHOT: TerminalSurfaceSnapshot = {
  status: 'starting',
  subtitle: 'Starting terminal...',
  isAtBottom: true,
  appearanceMode: 'dark',
  themeRestartRequired: false,
  themeRestartAllowed: false,
};

interface ReproTerminalBuffer {
  baseY: number;
  viewportY: number;
  getLine(line: number): { translateToString(trimRight?: boolean): string } | undefined;
}

interface ReproWindow extends Window {
  __tesseraTerminalScrollRepro?: {
    bufferType(): 'normal' | 'alternate' | null;
    capturePtyInput(): boolean;
    firstVisibleRowTag(): string | null;
    isAtBottom(): boolean | null;
    metrics(): { baseY: number; viewportY: number; rows: number } | null;
    mouseReporting(): boolean | null;
    takeCapturedPtyInput(): string[];
    visibleText(): string | null;
    viewportY(): number | null;
  };
}

export function TerminalScrollReproClient() {
  const isDark = useIsDark();
  const fontScale = useSettingsStore((state) => state.settings.fontSize);
  const terminalFontSize = getTerminalFontSize(fontScale);
  const connectionStatus = useChatStore((state) => state.connectionStatus);
  const hostRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [isSplit, setIsSplit] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.7);
  const surface = useMemo(() => getTerminalSurface({
    registryKey: REPRO_TERMINAL_ID,
    terminalId: REPRO_TERMINAL_ID,
    theme: getTerminalTheme(isDark),
    appearanceMode: isDark ? 'dark' : 'light',
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
    surface.setTheme(getTerminalTheme(isDark), isDark ? 'dark' : 'light');
  }, [isDark, surface]);

  useEffect(() => {
    surface.setFontSize(terminalFontSize);
  }, [surface, terminalFontSize]);

  useEffect(() => {
    const reproWindow = window as ReproWindow;
    const capturedPtyInput: string[] = [];
    let captureDisposable: { dispose(): void } | null = null;
    reproWindow.__tesseraTerminalScrollRepro = {
      capturePtyInput: () => {
        const terminal = (surface as unknown as {
          terminal: { onData(handler: (data: string) => void): { dispose(): void } } | null;
        }).terminal;
        if (!terminal || captureDisposable) return captureDisposable !== null;
        captureDisposable = terminal.onData((data) => {
          capturedPtyInput.push(data);
        });
        return true;
      },
      mouseReporting: () => (
        (surface as unknown as { terminal: { element?: HTMLElement } | null })
          .terminal?.element?.classList.contains('enable-mouse-events') ?? null
      ),
      takeCapturedPtyInput: () => capturedPtyInput.splice(0, capturedPtyInput.length),
      bufferType: () => (
        (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer & { type: 'normal' | 'alternate' } } } | null;
        }).terminal?.buffer.active.type ?? null
      ),
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
      metrics: () => {
        const terminal = (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer }; rows: number } | null;
        }).terminal;
        if (!terminal) return null;
        return {
          baseY: terminal.buffer.active.baseY,
          viewportY: terminal.buffer.active.viewportY,
          rows: terminal.rows,
        };
      },
      visibleText: () => {
        const terminal = (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer }; rows: number } | null;
        }).terminal;
        if (!terminal) return null;
        const { active } = terminal.buffer;
        return Array.from({ length: terminal.rows }, (_, offset) => (
          active.getLine(active.viewportY + offset)?.translateToString(true) ?? ''
        )).join('\n');
      },
      viewportY: () => (
        (surface as unknown as {
          terminal: { buffer: { active: ReproTerminalBuffer } } | null;
        }).terminal?.buffer.active.viewportY ?? null
      ),
    };
    return () => {
      captureDisposable?.dispose();
      delete reproWindow.__tesseraTerminalScrollRepro;
    };
  }, [surface]);

  useEffect(() => {
    const host = hostRef.current;
    if (!isVisible || !host) return;
    void surface.mount(host);
    return () => surface.unmount(host);
  }, [isSplit, isVisible, surface]);

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
          data-testid="toggle-terminal-split"
          onClick={() => setIsSplit((current) => !current)}
        >
          {isSplit ? 'Single panel' : 'Split panel'}
        </button>
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
        {isVisible && !isSplit && (
          <div ref={hostRef} className="h-full min-w-0 overflow-hidden" />
        )}
        {isVisible && isSplit && (
          <div
            ref={splitContainerRef}
            className="flex h-full min-h-0 min-w-0 overflow-hidden"
            data-testid="terminal-split-container"
          >
            <div
              className="min-h-0 min-w-0 overflow-hidden"
              style={{ flex: splitRatio }}
            >
              <div ref={hostRef} className="h-full min-w-0 overflow-hidden" />
            </div>
            <PanelDivider
              direction="horizontal"
              initialRatio={splitRatio}
              onResize={setSplitRatio}
              containerRef={splitContainerRef}
            />
            <div
              className="min-h-0 min-w-0 border-l border-(--divider)"
              data-testid="terminal-split-sibling"
              style={{ flex: 1 - splitRatio }}
            />
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
