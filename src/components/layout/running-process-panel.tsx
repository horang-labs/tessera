'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Terminal, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session-store';
import { selectIsTurnInFlight, useChatStore } from '@/stores/chat-store';
import { useBoardStore } from '@/stores/board-store';
import { useTabStore } from '@/stores/tab-store';
import { wsClient } from '@/lib/ws/client';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

interface RunningProcessPanelProps {
  /** Dropdown open direction: 'down' (header) or 'right' (vertical strip) */
  direction?: 'down' | 'right';
}

/**
 * RunningProcessPanel — badge showing count of running CLI processes
 * with a dropdown panel listing them and allowing stop/navigation.
 */
export function RunningProcessPanel({ direction = 'down' }: RunningProcessPanelProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Get all running sessions across all projects
  const projects = useSessionStore((state) => state.projects);
  const runningSessions = useMemo(() => {
    const sessions: Array<{ id: string; title: string; projectDir: string }> = [];
    for (const project of projects) {
      for (const session of project.sessions) {
        if (session.isRunning) {
          sessions.push({
            id: session.id,
            title: session.title,
            projectDir: project.encodedDir,
          });
        }
      }
    }
    return sessions;
  }, [projects]);

  const runningCount = runningSessions.length;

  const handleToggle = useCallback(() => {
    if (!isOpen && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setIsOpen((v) => !v);
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) return;
      setIsOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [isOpen]);

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  const handleStopSession = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    wsClient.stopSession(sessionId);
  }, []);

  const handleStopAll = useCallback(() => {
    for (const session of runningSessions) {
      wsClient.stopSession(session.id);
    }
    setIsOpen(false);
  }, [runningSessions]);

  const handleNavigateToSession = useCallback((sessionId: string, projectDir: string) => {
    // Switch to the session's project
    const boardStore = useBoardStore.getState();
    if (boardStore.selectedProjectDir !== projectDir) {
      boardStore.setSelectedProjectDir(projectDir);
      useTabStore.getState().switchProject(projectDir);
    }

    // Open session in tab (existing or new)
    const tabStore = useTabStore.getState();
    const existing = tabStore.findSessionLocation(sessionId);
    if (existing) {
      tabStore.setActiveTab(existing.tabId);
    } else {
      tabStore.createTab(sessionId);
    }

    // Set as active session
    useSessionStore.getState().setActiveSession(sessionId);

    setIsOpen(false);
  }, []);

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size={direction === 'right' ? 'icon-lg' : 'icon'}
        onClick={handleToggle}
        aria-label={t('status.runningProcesses')}
        title={runningCount > 0 ? t('task.board.running', { count: runningCount }) : t('status.noRunningProcesses')}
        className={direction === 'right' ? 'relative rounded-none h-11 w-9 mx-auto' : 'relative'}
      >
        <Terminal className={cn(
          direction === 'right' ? 'w-5 h-5' : 'w-4 h-4',
          runningCount === 0 && 'opacity-40',
        )} />
        {runningCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-(--success) text-[10px] font-bold text-white">
            {runningCount > 9 ? '9+' : runningCount}
          </span>
        )}
      </Button>

      {isOpen && anchorRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          className={cn(
            'fixed z-[9999] w-[280px] rounded-lg',
            'bg-(--sidebar-bg) border border-(--divider)',
            'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
          )}
          style={direction === 'right' ? {
            bottom: Math.max(8, window.innerHeight - anchorRect.bottom),
            left: anchorRect.right + 6,
          } : {
            top: anchorRect.bottom + 6,
            right: Math.max(8, window.innerWidth - anchorRect.right),
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-(--divider)">
            <span className="text-[12px] font-medium text-(--sidebar-text-active)">
              {t('status.runningProcesses')} ({runningCount})
            </span>
          </div>

          {/* Session list */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {runningSessions.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-(--text-muted)">
                {t('status.noRunningProcesses')}
              </div>
            ) : (
              runningSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onNavigate={handleNavigateToSession}
                  onStop={handleStopSession}
                />
              ))
            )}
          </div>

          {/* Stop all button */}
          {runningSessions.length > 1 && (
            <div className="border-t border-(--divider) px-3 py-2">
              <button
                onClick={handleStopAll}
                className={cn(
                  'w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md',
                  'text-[11px] font-medium text-(--error)',
                  'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
                  'transition-colors cursor-default',
                )}
              >
                <Square className="w-3 h-3 fill-current" />
                {t('status.stopAll')}
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

/** Individual session row in the dropdown */
function SessionRow({
  session,
  onNavigate,
  onStop,
}: {
  session: { id: string; title: string; projectDir: string };
  onNavigate: (id: string, projectDir: string) => void;
  onStop: (id: string, e: React.MouseEvent) => void;
}) {
  const isProcessing = useChatStore(selectIsTurnInFlight(session.id));
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onNavigate(session.id, session.projectDir);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left',
        'hover:bg-(--sidebar-hover) transition-colors cursor-default',
      )}
      onClick={() => onNavigate(session.id, session.projectDir)}
      onKeyDown={handleKeyDown}
    >
      {/* Status indicator */}
      {isProcessing ? (
        <div className="w-2 h-2 rounded-full border-[1.5px] border-(--success)/30 border-t-(--success) animate-[spin_2s_linear_infinite] shrink-0" />
      ) : (
        <div className="w-2 h-2 rounded-full bg-(--success) shrink-0" />
      )}

      {/* Title */}
      <span className="flex-1 min-w-0 truncate text-[12px] text-(--sidebar-text-active)">
        {session.title}
      </span>

      {/* Stop button */}
      <button
        type="button"
        onClick={(e) => onStop(session.id, e)}
        className={cn(
          'shrink-0 p-1 rounded transition-colors',
          'text-(--text-muted) hover:text-(--error)',
          'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
        )}
        aria-label="Stop process"
        title="Stop process"
      >
        <Square className="w-3 h-3 fill-current" />
      </button>
    </div>
  );
}
