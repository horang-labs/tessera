'use client';

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { useTerminalViewModeStore } from '@/stores/terminal-view-mode-store';
import { getSessionSelectionId } from '@/lib/constants/special-sessions';
import { getInitialTerminalCwd } from '@/lib/terminal/client-terminal-cwd';
import {
  closeAndDisposeTerminalSurface,
  getTerminalPromptBounds,
  getTerminalSurface,
} from '@/lib/terminal/terminal-surface-registry';
import { TerminalInputBar } from '@/components/terminal/terminal-input-bar';
import { uploadTerminalClipboardFile } from '@/lib/terminal/terminal-clipboard-paste';
import { useIsDark } from '@/hooks/use-is-dark';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { getTerminalFontSize } from '@/lib/terminal/terminal-font-size';
import { registerTerminalPreviewSurface } from '@/lib/terminal/terminal-preview-surface-lifecycle';
import {
  getInternalPathDropPaths,
  hasPathInsertDragData,
  hasWorkspaceFileDragData,
  isSessionReferenceDragData,
  setPanelNodeDragData,
} from '@/lib/dnd/panel-session-drag';
import {
  getNativeFileDropAbsolutePaths,
  isNativeFileDrag,
} from '@/lib/dnd/native-file-drop';
import { insertFilePathIntoTerminal } from '@/lib/terminal/terminal-file-path-insert';
import { insertSessionReferenceIntoTerminal } from '@/lib/session/session-reference';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { toast } from '@/stores/notification-store';
import {
  PANEL_NODE_DRAG_MIME,
  PANEL_SESSION_DRAG_MIME,
  SESSION_DRAG_MIME,
  TAB_DRAG_MIME,
  TAB_PANEL_TREE_DND_MIME,
} from '@/types/panel';
import { PanelDropZone } from '@/components/panel/panel-drop-zone';
import { telemetryClickAttributes, telemetryIgnoreAttributes } from '@/lib/telemetry/ui-click';
import {
  getPanelSplitSpec,
  isPanelLargeEnoughToSplit,
} from '@/lib/panel/panel-split';
import {
  subscribeToTerminalPanelViewModeRequests,
  subscribeToTerminalPanelSplitRequests,
} from '@/lib/panel/electron-terminal-panel-context-menu';

interface TerminalPanelProps {
  panelId: string;
  terminalId: string;
  terminalSessionId: string | null;
  terminalCwd?: string | null;
  /** Determines whether unmount detaches, or may close a preview-created PTY. */
  runtimeOwnership?: 'standalone' | 'session-preview' | 'session-retained' | 'session-peek';
  /** Treat a transient surface as visible/focused without borrowing panel-store state. */
  surfaceActive?: boolean;
  /** Accept prompt-input drops directly when no PanelWrapper surrounds this surface. */
  directInputDrop?: boolean;
  /**
   * Leave the PTY running when this surface goes away. Set it for a runtime the
   * server owns and merely lets a surface watch — closing the view has to detach
   * from the work, not end it.
   */
  detachOnUnmount?: boolean;
  /** Optional overlay shown until the terminal surface reports that it is running. */
  startupOverlay?: ReactNode;
  launch?: { providerId: string; sessionId: string };
  /**
   * The panel's own title bar — drag handle, path, close button.
   *
   * A surface embedded in something that already says what it is showing turns
   * it off: two headers for one terminal read as two things, and a close button
   * on a run somebody else started raises a question it cannot answer.
   */
  showHeader?: boolean;
  /** Expose the native-menu transition to this session's transcript-backed chat surface. */
  chatViewAvailable?: boolean;
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
  terminalCwd = null,
  runtimeOwnership = 'standalone',
  surfaceActive = false,
  directInputDrop = false,
  detachOnUnmount = false,
  startupOverlay,
  launch,
  showHeader = true,
  chatViewAvailable = false,
}: TerminalPanelProps) {
  const tabId = useContext(TabIdContext);
  const { t } = useTranslation();
  const isDark = useIsDark();
  const isPhoneViewport = usePhoneViewport();
  const fontScale = useSettingsStore((state) => state.settings.fontSize);
  const lightThemePreset = useSettingsStore((state) => state.settings.terminalThemeLightPreset);
  const darkThemePreset = useSettingsStore((state) => state.settings.terminalThemeDarkPreset);
  const selectedThemePreset = isDark ? darkThemePreset : lightThemePreset;
  const terminalFontSize = getTerminalFontSize(fontScale);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingSurfaceCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const directDragCounterRef = useRef(0);
  const directDropKindRef = useRef<'path' | 'session' | null>(null);
  const [directDropKind, setDirectDropKind] = useState<'path' | 'session' | null>(null);
  const [directSessionDropZone, setDirectSessionDropZone] = useState<{
    top: number;
    height: number;
  } | null>(null);
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
    cwd: getInitialTerminalCwd(terminalSessionId, terminalCwd),
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
    terminalCwd,
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
  const handleInputBarSend = useCallback(
    (data: string) => surface.sendUserInput(data),
    [surface],
  );
  const handleInputBarImage = useCallback(async (file: File) => {
    const uploadedPath = await uploadTerminalClipboardFile(file);
    return surface.pasteUserInput(uploadedPath);
  }, [surface]);
  const handleTerminalPointerDown = useCallback(() => {
    if (!isPhoneViewport) return;
    const activeElement = containerRef.current?.ownerDocument.activeElement;
    if (activeElement?.getAttribute('data-terminal-input-owner') === 'input-bar') {
      (activeElement as HTMLElement).blur();
    }
  }, [isPhoneViewport]);

  const resetDirectInputDrop = useCallback(() => {
    directDragCounterRef.current = 0;
    directDropKindRef.current = null;
    setDirectDropKind(null);
    setDirectSessionDropZone(null);
  }, []);

  const resolveDirectInputDropKind = useCallback((dataTransfer: DataTransfer) => {
    if (
      isNativeFileDrag(dataTransfer) ||
      hasWorkspaceFileDragData(dataTransfer) ||
      hasPathInsertDragData(dataTransfer)
    ) {
      return 'path' as const;
    }
    const isLayoutDrag = [
      PANEL_SESSION_DRAG_MIME,
      PANEL_NODE_DRAG_MIME,
      TAB_DRAG_MIME,
      TAB_PANEL_TREE_DND_MIME,
    ].some((mime) => dataTransfer.types.includes(mime));
    if (!isLayoutDrag && isSessionReferenceDragData(dataTransfer)) return 'session' as const;
    return null;
  }, []);

  const handleInputDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!resolveDirectInputDropKind(event.dataTransfer)) return;
    directDragCounterRef.current += 1;
  }, [resolveDirectInputDropKind]);

  const handleInputDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    const kind = resolveDirectInputDropKind(event.dataTransfer);
    if (!kind) return;

    if (kind === 'session') {
      const hostRect = event.currentTarget.getBoundingClientRect();
      const promptBounds = getTerminalPromptBounds(terminalId) ?? {
        top: hostRect.bottom - 56,
        bottom: hostRect.bottom,
      };
      const isOverPrompt = event.clientY >= promptBounds.top && event.clientY <= promptBounds.bottom;
      if (!isOverPrompt) {
        directDropKindRef.current = null;
        setDirectDropKind(null);
        setDirectSessionDropZone(null);
        return;
      }
      setDirectSessionDropZone({
        top: promptBounds.top - hostRect.top,
        height: promptBounds.bottom - promptBounds.top,
      });
    } else {
      setDirectSessionDropZone(null);
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = isNativeFileDrag(event.dataTransfer) ? 'copy' : 'move';
    directDropKindRef.current = kind;
    setDirectDropKind(kind);
  }, [resolveDirectInputDropKind, terminalId]);

  const handleInputDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!resolveDirectInputDropKind(event.dataTransfer)) return;
    directDragCounterRef.current -= 1;
    if (directDragCounterRef.current <= 0) resetDirectInputDrop();
  }, [resetDirectInputDrop, resolveDirectInputDropKind]);

  const handleInputDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    const kind = directDropKindRef.current;
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    resetDirectInputDrop();

    if (kind === 'path') {
      const paths = isNativeFileDrag(event.dataTransfer)
        ? getNativeFileDropAbsolutePaths(event.dataTransfer)
        : getInternalPathDropPaths(event.dataTransfer);
      let inserted = false;
      for (const path of paths) {
        if (insertFilePathIntoTerminal(terminalId, path)) inserted = true;
      }
      if (inserted) surface.activate();
      return;
    }

    const referencedSessionId = event.dataTransfer.getData(SESSION_DRAG_MIME);
    if (!referencedSessionId) return;
    const title = projectViewWorkspaceState.resolveSession(referencedSessionId)?.title
      ?? referencedSessionId.slice(0, 8);
    void insertSessionReferenceIntoTerminal(terminalId, referencedSessionId, title)
      .then((inserted) => {
        if (inserted) surface.activate();
      })
      .catch(() => toast.error(t('errors.sessionExportFailed')));
  }, [resetDirectInputDrop, surface, t, terminalId]);

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
    surface.setKeyboardOwner(isPhoneViewport ? 'input-bar' : 'xterm');
    return () => surface.setKeyboardOwner('xterm');
  }, [isPhoneViewport, surface]);

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

  useEffect(function subscribeToTerminalPanelContextMenu() {
    return subscribeToTerminalPanelSplitRequests((request) => {
      if (request.panelId !== panelId) return;

      const wrapper = Array.from(
        document.querySelectorAll<HTMLElement>('[data-panel-wrapper="true"][data-panel-id]'),
      ).find((element) => element.dataset.panelId === panelId);
      const { direction, position } = getPanelSplitSpec(request.placement);
      if (wrapper && !isPanelLargeEnoughToSplit(wrapper.getBoundingClientRect(), direction)) {
        toast.warning(t('panel.tooSmallToSplit'));
        return;
      }

      const panelStore = usePanelStore.getState();
      panelStore.setActivePanelId(panelId);
      const newPanelId = panelStore.splitPanel(panelId, direction, null, position);
      if (!newPanelId) return;

      const tabStore = useTabStore.getState();
      tabStore.pinTab(tabStore.activeTabId);
    });
  }, [panelId, t]);

  useEffect(function subscribeToTerminalPanelViewModeContextMenu() {
    if (!chatViewAvailable || !terminalSessionId) return;
    return subscribeToTerminalPanelViewModeRequests((request) => {
      if (request.panelId !== panelId) return;
      useTerminalViewModeStore.getState().setMode(terminalSessionId, request.mode);
    });
  }, [chatViewAvailable, panelId, terminalSessionId]);

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
        } else if (detachOnUnmount || sessionOwned || isTerminalAssignedToAnyPanel(terminalId)) {
          surface.dispose();
        } else {
          closeAndDisposeTerminalSurface(surface);
        }
      }, 0);
    };
  }, [detachOnUnmount, panelId, sessionOwned, surface, tabId, terminalId, terminalSessionId]);

  useEffect(() => {
    const shouldRestoreRetainedSession = runtimeOwnership === 'session-retained';
    if (connectionStatus !== 'connected' || (!isTabActive && !shouldRestoreRetainedSession)) return;
    void surface.ensureConnected().then((connected) => {
      if (connected && isPanelActive) surface.activate();
    });
  }, [connectionStatus, isPanelActive, isPhoneViewport, isTabActive, runtimeOwnership, surface]);

  const canRestart = status === 'exited' || status === 'error';
  const handleThemeRestart = useCallback(() => {
    surface.restartForTheme();
  }, [surface]);

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-testid="terminal-panel"
      data-terminal-panel-id={panelId}
      data-terminal-chat-view-available={chatViewAvailable ? 'true' : undefined}
      style={{ backgroundColor: terminalTheme.background, color: terminalTheme.foreground }}
      onDragEnter={directInputDrop ? handleInputDragEnter : undefined}
      onDragOver={directInputDrop ? handleInputDragOver : undefined}
      onDragLeave={directInputDrop ? handleInputDragLeave : undefined}
      onDrop={directInputDrop ? handleInputDrop : undefined}
    >
      {!sessionOwned && showHeader && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/10 px-2 text-xs dark:border-white/10">
          <button
            {...telemetryIgnoreAttributes('drag_only')}
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
            {...telemetryClickAttributes('terminal.action', 'terminal')}
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
      <div
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        onPointerDownCapture={handleTerminalPointerDown}
      >
        <div ref={containerRef} className="h-full min-w-0 overflow-hidden" />
        {status === 'starting' && startupOverlay ? (
          <div className="absolute inset-0 z-10">{startupOverlay}</div>
        ) : null}
        {!isAtBottom && (
          <ScrollToBottomButton
            telemetryTarget={{ control: 'terminal.scroll_bottom', surface: 'terminal' }}
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
                  {...telemetryClickAttributes('terminal.restart', 'terminal')}
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
      {/* Conditional render for the viewport, never `display: none`: a desktop tree must
          not contain the bar at all. Being on an inactive tab is the other question and
          takes the other answer — the bar stays mounted and drops out of layout, so a
          draft survives a tab switch (#262). The surface receives the same Phone state so
          xterm keeps touch/pointer behavior but yields keyboard ownership to this bar. */}
      {isPhoneViewport && (
        <TerminalInputBar
          onSend={handleInputBarSend}
          onAttachImage={handleInputBarImage}
          isTabActive={isTabActive}
        />
      )}
      {directDropKind === 'path' ? (
        <PanelDropZone edge="center" label={t('panel.dropToInsertPath')} />
      ) : null}
      {directDropKind === 'session' && directSessionDropZone ? (
        <div
          className="pointer-events-none absolute inset-x-1 z-50 flex items-center justify-center rounded-md border-2 border-solid border-(--accent) bg-(--accent)/25"
          style={{ top: directSessionDropZone.top, height: directSessionDropZone.height }}
          data-testid="session-insert-drop-zone"
        >
          <span className="rounded-md bg-(--accent) px-2 py-1 text-xs font-medium text-white shadow-sm">
            {t('panel.dropToInsertSessionReference')}
          </span>
        </div>
      ) : null}
    </div>
  );
}
