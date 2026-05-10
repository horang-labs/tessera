'use client';

import { useCallback, useContext, useEffect, useRef, useState, type DragEvent } from 'react';
import { GripVertical, Terminal as TerminalIcon, X } from 'lucide-react';
import { wsClient } from '@/lib/ws/client';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { Button } from '@/components/ui/button';
import { TabIdContext, usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { getInitialTerminalCwd } from '@/lib/terminal/client-terminal-cwd';
import { setPanelNodeDragData } from '@/lib/dnd/panel-session-drag';

interface TerminalPanelProps {
  panelId: string;
  terminalId: string;
  terminalSessionId: string | null;
}

function isTerminalAssignedToAnyPanel(terminalId: string): boolean {
  const { tabPanels } = usePanelStore.getState();
  return Object.values(tabPanels).some((tabData) =>
    Object.values(tabData.panels).some((panel) => panel.terminalId === terminalId),
  );
}

export function TerminalPanel({ panelId, terminalId, terminalSessionId }: TerminalPanelProps) {
  const tabId = useContext(TabIdContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const closeRequestedRef = useRef(false);
  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>('starting');
  const [subtitle, setSubtitle] = useState('Starting terminal...');
  const assignTerminal = usePanelStore((state) => state.assignTerminal);
  const connectionStatus = useChatStore((state) => state.connectionStatus);

  const handlePanelDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    const didSet = setPanelNodeDragData(event.dataTransfer, { tabId, panelId });
    if (!didSet) {
      event.preventDefault();
    }
  }, [panelId, tabId]);

  const handleCloseTerminal = useCallback(() => {
    closeRequestedRef.current = true;
    wsClient.closeTerminal(terminalId);
    assignTerminal(panelId, null);
  }, [assignTerminal, panelId, terminalId]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    closeRequestedRef.current = false;
    const unsubscribe = wsClient.subscribeServerMessages((message: ServerTransportMessage) => {
      if (!('terminalId' in message) || message.terminalId !== terminalId) return;

      if (message.type === 'terminal_started') {
        setStatus('running');
        setSubtitle(`${message.shell} - ${message.cwd}`);
        return;
      }

      if (message.type === 'terminal_output') {
        terminalRef.current?.write(message.data);
        return;
      }

      if (message.type === 'terminal_exit') {
        setStatus('exited');
        setSubtitle(`Terminal exited with code ${message.exitCode}`);
        return;
      }

      if (message.type === 'terminal_error') {
        setStatus('error');
        setSubtitle(message.message);
      }
    });

    async function mountTerminal() {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        if (disposed || !containerRef.current) return;

        const terminal = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          theme: {
            background: '#0f1115',
            foreground: '#d7dde3',
            cursor: '#d7dde3',
          },
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        fitAddon.fit();
        terminal.focus();

        terminal.onData((data: string) => {
          wsClient.sendTerminalInput(terminalId, data);
        });

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        if (connectionStatus !== 'connected') {
          setStatus('starting');
          setSubtitle('Waiting for server connection...');
          return;
        }

        const dimensions = fitAddon.proposeDimensions();
        const didCreateTerminal = wsClient.createTerminal({
          terminalId,
          cwd: getInitialTerminalCwd(terminalSessionId),
          sessionId: getSessionSelectionId(terminalSessionId),
          cols: dimensions?.cols,
          rows: dimensions?.rows,
        });
        if (!didCreateTerminal) {
          setStatus('starting');
          setSubtitle('Waiting for server connection...');
          return;
        }

        resizeObserver = new ResizeObserver(() => {
          if (!fitAddonRef.current) return;
          fitAddonRef.current.fit();
          const next = fitAddonRef.current.proposeDimensions();
          if (next) {
            wsClient.resizeTerminal(terminalId, next.cols, next.rows);
          }
        });
        resizeObserver.observe(containerRef.current);
      } catch (error) {
        setStatus('error');
        setSubtitle(error instanceof Error ? error.message : 'Terminal failed to load.');
      }
    }

    void mountTerminal();

    return () => {
      disposed = true;
      unsubscribe();
      resizeObserver?.disconnect();
      terminalRef.current?.dispose?.();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (!closeRequestedRef.current && !isTerminalAssignedToAnyPanel(terminalId)) {
        wsClient.closeTerminal(terminalId);
      }
    };
  }, [connectionStatus, terminalId, terminalSessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f1115] text-[#d7dde3]" data-testid="terminal-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-2 text-xs">
        <button
          type="button"
          draggable
          onDragStart={handlePanelDragStart}
          title="Move terminal panel"
          aria-label="Move terminal panel"
          data-testid="terminal-panel-drag-handle"
          className="cursor-grab rounded p-1 text-white/45 transition-colors hover:bg-white/10 hover:text-white active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <TerminalIcon className="h-4 w-4 text-(--accent)" />
        <div className="flex min-w-0 shrink items-center gap-2 select-text">
          <span className="font-medium">Terminal</span>
          <span className="min-w-0 truncate text-white/55">{subtitle}</span>
        </div>
        <div
          draggable
          onDragStart={handlePanelDragStart}
          title="Move terminal panel"
          aria-label="Move terminal panel"
          data-testid="terminal-panel-empty-drag-region"
          className="h-full min-w-8 flex-1 cursor-grab active:cursor-grabbing"
        />
        <span className="text-white/45">{status}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={handleCloseTerminal}
          aria-label="Close terminal"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div ref={containerRef} className="h-full min-h-0 overflow-hidden" />
      </div>
    </div>
  );
}
