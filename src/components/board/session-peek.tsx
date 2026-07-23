'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Terminal, X } from 'lucide-react';
import { ChatArea } from '@/components/chat/chat-area';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { MemoryFileTab } from '@/components/memory/memory-file-tab';
import { WorkspaceFileTab } from '@/components/workspace/workspace-file-tab';
import { TabIdContext } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import {
  DEFAULT_PEEK_FILE_SIDECAR_WIDTH,
  MIN_PEEK_FILE_SIDECAR_WIDTH,
  useBoardStore,
} from '@/stores/board-store';
import { useI18n } from '@/lib/i18n';

interface SessionPeekProps {
  sessionId: string;
  showSessionContent?: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const PEEK_TAB_ID = 'kanban-session-peek';
const PEEK_PANEL_ID = 'kanban-session-peek-panel';
const PEEK_FILE_TAB_ID = 'kanban-file-peek';
const PEEK_FILE_PANEL_ID = 'kanban-file-peek-panel';
const MIN_SESSION_PANE_WIDTH = 420;
const RESIZE_HANDLE_WIDTH = 7;
const RESIZE_KEYBOARD_STEP = 24;

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

export function SessionPeek({
  sessionId,
  showSessionContent = true,
  onClose,
}: SessionPeekProps) {
  const { t } = useI18n();
  const session = useSessionStore((state) => state.getSession(sessionId));
  const peekFileRef = useBoardStore((state) => state.peekFileRef);
  const persistedFileWidth = useBoardStore((state) => state.peekFileSidecarWidth);
  const closePeekFile = useBoardStore((state) => state.closePeekFile);
  const openPeekFile = useBoardStore((state) => state.openPeekFile);
  const setPeekFileDirty = useBoardStore((state) => state.setPeekFileDirty);
  const setPersistedFileWidth = useBoardStore((state) => state.setPeekFileSidecarWidth);
  const dialogRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const backdropPointerStartedRef = useRef(false);
  const resizeDragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const resizeWidthRef = useRef(persistedFileWidth);
  const [fileSidecarWidth, setFileSidecarWidth] = useState(persistedFileWidth);
  const [splitContainerWidth, setSplitContainerWidth] = useState(0);
  const isTerminal = session?.kind === 'terminal';
  const isFileOnly = !showSessionContent && Boolean(peekFileRef);
  const isSplit = showSessionContent && Boolean(peekFileRef);
  const titleId = `session-peek-title-${sessionId}`;

  useEffect(() => {
    const container = splitContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const updateWidth = () => setSplitContainerWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isSplit]);

  const clampFileWidth = useCallback((width: number, containerWidth = splitContainerWidth) => {
    const maxWidth = Math.max(
      MIN_PEEK_FILE_SIDECAR_WIDTH,
      containerWidth - MIN_SESSION_PANE_WIDTH - RESIZE_HANDLE_WIDTH,
    );
    return Math.min(maxWidth, Math.max(MIN_PEEK_FILE_SIDECAR_WIDTH, width));
  }, [splitContainerWidth]);

  const applyFileWidth = useCallback((width: number, persist: boolean) => {
    const nextWidth = clampFileWidth(width);
    resizeWidthRef.current = nextWidth;
    setFileSidecarWidth(nextWidth);
    if (persist) setPersistedFileWidth(nextWidth);
  }, [clampFileWidth, setPersistedFileWidth]);

  const finishResize = useCallback(() => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
    resizeDragRef.current = null;
    setPersistedFileWidth(resizeWidthRef.current);
  }, [setPersistedFileWidth]);

  useEffect(() => () => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
  }, []);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    (closeButtonRef.current ?? dialogRef.current)?.focus({ preventScroll: true });

    return () => {
      const returnTarget = returnFocusRef.current;
      requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    if (!session) onClose();
  }, [onClose, session]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Escape is application input in PTY programs, and GUI composers use it
      // for cancelling generation and closing their own transient controls.
      if (isTextEditingTarget(event.target)) return;
      if (peekFileRef) {
        event.preventDefault();
        closePeekFile();
        return;
      }
      if (isTerminal) return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closePeekFile, isTerminal, onClose, peekFileRef]);

  const handleDialogKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const handleBackdropPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    backdropPointerStartedRef.current = event.target === event.currentTarget;
  }, []);

  const handleBackdropPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const shouldClose = backdropPointerStartedRef.current && event.target === event.currentTarget;
    backdropPointerStartedRef.current = false;
    if (shouldClose) onClose();
  }, [onClose]);

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: resizeWidthRef.current,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const containerWidth = splitContainerRef.current?.clientWidth ?? splitContainerWidth;
    const nextWidth = clampFileWidth(
      drag.startWidth - (event.clientX - drag.startX),
      containerWidth,
    );
    resizeWidthRef.current = nextWidth;
    setFileSidecarWidth(nextWidth);
  }, [clampFileWidth, splitContainerWidth]);

  const handleResizePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize();
  }, [finishResize]);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') {
      nextWidth = fileSidecarWidth + RESIZE_KEYBOARD_STEP;
    } else if (event.key === 'ArrowRight') {
      nextWidth = fileSidecarWidth - RESIZE_KEYBOARD_STEP;
    } else if (event.key === 'Home') {
      nextWidth = MIN_PEEK_FILE_SIDECAR_WIDTH;
    } else if (event.key === 'End') {
      nextWidth = splitContainerWidth - MIN_SESSION_PANE_WIDTH - RESIZE_HANDLE_WIDTH;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    applyFileWidth(nextWidth, true);
  }, [applyFileWidth, fileSidecarWidth, splitContainerWidth]);

  if (!session) return null;

  const SessionIcon = isTerminal ? Terminal : MessageSquare;
  const effectiveFileWidth = clampFileWidth(fileSidecarWidth);
  const surfaceBadge = isTerminal ? 'PTY' : 'GUI';
  const peekFileLabel = peekFileRef?.type === 'workspace-file'
    ? peekFileRef.path
    : peekFileRef?.fileName;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-5"
      data-testid="kanban-session-peek-backdrop"
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onPointerCancel={() => { backdropPointerStartedRef.current = false; }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={showSessionContent ? titleId : undefined}
        aria-label={isFileOnly ? peekFileLabel : undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="flex min-h-0 overflow-hidden rounded-xl border border-(--divider) bg-(--chat-bg) shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
        style={{
          width: peekFileRef ? 'min(96%, 88rem)' : 'min(92%, 72rem)',
          height: '92%',
        }}
        data-testid="kanban-session-peek"
        data-session-kind={isTerminal ? 'terminal' : 'chat'}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showSessionContent ? (
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--chat-header-border) bg-(--chat-header-bg) px-3">
              <SessionIcon className="h-4 w-4 shrink-0 text-(--accent)" aria-hidden="true" />
              <h2
                id={titleId}
                className="min-w-0 flex-1 truncate text-sm font-semibold text-(--text-primary)"
              >
                {session.title}
              </h2>
              <span className="rounded-full border border-(--divider) px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-(--text-muted)">
                {surfaceBadge}
              </span>
              <ShortcutTooltip id="close-tab" label={t('common.close')}>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={onClose}
                  className="rounded-md p-1.5 text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
                  aria-label={t('common.close')}
                  data-testid="kanban-session-peek-close"
                >
                  <X className="h-4 w-4" />
                </button>
              </ShortcutTooltip>
            </header>
          ) : null}
          <div
            ref={splitContainerRef}
            className="flex min-h-0 flex-1 overflow-hidden"
            data-testid="kanban-peek-split-container"
          >
            {showSessionContent ? (
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <TabIdContext.Provider value={PEEK_TAB_ID}>
                  <ChatArea
                    key={sessionId}
                    sessionId={sessionId}
                    panelId={PEEK_PANEL_ID}
                    presentation="peek"
                  />
                </TabIdContext.Provider>
              </div>
            ) : null}

            {isSplit ? (
              <div
                role="separator"
                aria-label="Resize file preview"
                aria-orientation="vertical"
                aria-valuemin={MIN_PEEK_FILE_SIDECAR_WIDTH}
                aria-valuemax={Math.max(
                  MIN_PEEK_FILE_SIDECAR_WIDTH,
                  splitContainerWidth - MIN_SESSION_PANE_WIDTH - RESIZE_HANDLE_WIDTH,
                )}
                aria-valuenow={Math.round(effectiveFileWidth)}
                tabIndex={0}
                onDoubleClick={() => applyFileWidth(DEFAULT_PEEK_FILE_SIDECAR_WIDTH, true)}
                onKeyDown={handleResizeKeyDown}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerEnd}
                onPointerCancel={handleResizePointerEnd}
                className="group relative z-10 w-[7px] shrink-0 cursor-col-resize bg-(--divider) outline-none transition-colors hover:bg-(--accent) focus-visible:bg-(--accent)"
                style={{ touchAction: 'none' }}
                data-testid="kanban-peek-file-resize-handle"
              >
                <span className="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
              </div>
            ) : null}

            {peekFileRef ? (
              <aside
                className="min-h-0 min-w-0 shrink-0 overflow-hidden bg-(--chat-bg)"
                style={isSplit ? { width: effectiveFileWidth } : { flex: '1 1 0%' }}
                data-testid="kanban-peek-file-sidecar"
                data-file-type={peekFileRef.type}
              >
                <TabIdContext.Provider value={PEEK_FILE_TAB_ID}>
                  {peekFileRef.type === 'memory-file' ? (
                    <MemoryFileTab
                      key={`${peekFileRef.sourceSessionId}:${peekFileRef.memoryKind}:${peekFileRef.fileName}`}
                      memoryRef={peekFileRef}
                      panelId={PEEK_FILE_PANEL_ID}
                      onClose={closePeekFile}
                      onDirtyChange={setPeekFileDirty}
                    />
                  ) : (
                    <WorkspaceFileTab
                      key={`${peekFileRef.sourceSessionId}:${peekFileRef.kind}:${peekFileRef.path}`}
                      fileRef={peekFileRef}
                      panelId={PEEK_FILE_PANEL_ID}
                      surfaceActive
                      onClose={closePeekFile}
                      onFileRefChange={openPeekFile}
                    />
                  )}
                </TabIdContext.Provider>
              </aside>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
