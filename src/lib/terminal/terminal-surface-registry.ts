'use client';

import type { ITheme } from '@xterm/xterm';
import { v4 as uuidv4 } from 'uuid';
import { wsClient } from '@/lib/ws/client';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { useSessionStore } from '@/stores/session-store';
import { useNotificationStore } from '@/stores/notification-store';
import {
  setPendingTerminalLaunch,
  takePendingTerminalLaunch,
  type PendingTerminalLaunch,
} from './pending-terminal-launch';
import { dispatchTerminalLaunchResult } from './terminal-launch-result';
import { clearClientTerminalHandoff } from './client-terminal-handoff-state';
import {
  getTerminalTheme,
  getTerminalThemePresets,
  type TesseraTerminalTheme,
} from './terminal-theme';
import type {
  TerminalAppearance,
  TerminalColorSchemeMode,
  TerminalLaunchIntent,
} from './types';
import {
  detectTerminalClientPlatform,
  isTerminalPasteShortcut,
  resolveTerminalInputAction,
} from './terminal-key-input';
import {
  pasteTerminalClipboard,
  uploadTerminalClipboardFile,
  uploadTerminalClipboardImage,
  type ElectronTerminalClipboardApi,
} from './terminal-clipboard-paste';
import {
  scheduleTerminalScrollIntentSync,
  TerminalScrollController,
  type TerminalScrollRestorePoint,
  type TerminalScrollTarget,
} from './terminal-scroll-controller';
import { LayoutSettleRunner } from './layout-settle-runner';
import { createTerminalExternalLinkHandlers } from './terminal-external-link';
import {
  QuietTerminalRenderRecovery,
  TerminalBackgroundSgrDetector,
  resetAndRefreshTerminalRenderers,
} from './terminal-render-recovery';
import {
  attachTerminalMouseWheelMultiplier,
  isTerminalTuiOwnedWheelEvent,
} from './terminal-mouse-wheel';

export type TerminalSurfaceStatus = 'starting' | 'running' | 'exited' | 'error';

export interface TerminalSurfaceSnapshot {
  status: TerminalSurfaceStatus;
  subtitle: string;
  isAtBottom: boolean;
  appearanceMode: TerminalColorSchemeMode;
  themeRestartRequired: boolean;
  themeRestartAllowed: boolean;
}

export interface TerminalSurfaceOptions {
  registryKey: string;
  terminalId: string;
  theme: TesseraTerminalTheme;
  appearanceMode: TerminalColorSchemeMode;
  fontSize: number;
  cwd?: string | null;
  sessionId?: string | null;
  launch?: { providerId: string; sessionId: string };
  previewOwned?: boolean;
}

type XtermLike = TerminalScrollTarget & {
  cols: number;
  rows: number;
  options: { theme?: ITheme; fontSize?: number };
  unicode: { activeVersion: string };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void;
  element?: HTMLElement;
  loadAddon(addon: unknown): void;
  open(element: HTMLElement): void;
  focus(): void;
  paste(data: string): void;
  write(data: string, callback?: () => void): void;
  reset(): void;
  refresh(start: number, end: number): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onScroll(callback: (viewportY: number) => void): { dispose(): void };
  dispose(): void;
};

type FitAddonLike = {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
  dispose?(): void;
};

const surfaces = new Map<string, TerminalSurface>();
function recoverAllTerminalRenderers(): void {
  resetAndRefreshTerminalRenderers(surfaces.values());
}
const sharedTerminalRenderRecovery = new QuietTerminalRenderRecovery(
  recoverAllTerminalRenderers,
);
let parkingLot: HTMLElement | null = null;

/**
 * How long a surface stays hot (xterm/WebGL alive) after its tab goes
 * inactive, or after its host unmounts, before it cold-parks: see
 * `TerminalSurface.coldPark`.
 */
const COLD_PARK_DELAY_MS = 30_000;
const TERMINAL_RESIZE_SETTLE_DELAY_MS = 150;

function getParkingLot(): HTMLElement {
  if (parkingLot?.isConnected) return parkingLot;

  const element = document.createElement('div');
  element.dataset.tesseraTerminalParking = 'true';
  Object.assign(element.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  document.body.appendChild(element);
  parkingLot = element;
  return element;
}

function isModifierOnlyKey(key: string): boolean {
  return key === 'Shift'
    || key === 'Control'
    || key === 'Alt'
    || key === 'Meta'
    || key === 'CapsLock'
    || key === 'NumLock'
    || key === 'ScrollLock';
}

/**
 * Browser-side terminal surface with a lifetime independent from React.
 *
 * The xterm instance and its DOM stay alive while a session is temporarily out
 * of view. A WebSocket reconnect reattaches the same surface and uses the
 * server's serialized snapshot as the cold-recovery path.
 */
export class TerminalSurface {
  readonly surfaceId = uuidv4();

  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeMessages: () => void;
  private state: TerminalSurfaceSnapshot = {
    status: 'starting',
    subtitle: 'Starting terminal...',
    isAtBottom: true,
    appearanceMode: 'dark',
    themeRestartRequired: false,
    themeRestartAllowed: false,
  };
  private actualTerminalId: string;
  private theme: TesseraTerminalTheme;
  private appearanceMode: TerminalColorSchemeMode;
  private requestedTheme: { theme: TesseraTerminalTheme; mode: TerminalColorSchemeMode } | null = null;
  private themeRestartLaunchIntent: TerminalLaunchIntent | null = null;
  private themeRestartPending = false;
  private fontSize: number;
  private terminal: XtermLike | null = null;
  private fitAddon: FitAddonLike | null = null;
  private webglAddon: { clearTextureAtlas(): void; dispose(): void } | null = null;
  private readonly backgroundSgrDetector = new TerminalBackgroundSgrDetector();
  private inputDisposable: { dispose(): void } | null = null;
  private scrollDisposable: { dispose(): void } | null = null;
  private scrollController: TerminalScrollController | null = null;
  private unsubscribeScrollController: (() => void) | null = null;
  private scrollTrackingCleanup: (() => void) | null = null;
  private pendingScrollStateFrameId: number | null = null;
  private scrollRebuildSettleTimerId: number | null = null;
  private readonly scrollSyncSettler = new LayoutSettleRunner();
  private pasteListener: ((event: ClipboardEvent) => void) | null = null;
  private compositionEndListener: ((event: CompositionEvent) => void) | null = null;
  private clipboardPasteQueue: Promise<void> = Promise.resolve();
  private root: HTMLDivElement | null = null;
  private intendedHost: HTMLElement | null = null;
  private mountedHost: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pendingFitFrameId: number | null = null;
  private pendingFitClaim = false;
  private resizeSettleTimerId: number | null = null;
  private initializePromise: Promise<boolean> | null = null;
  private coldParkTimerId: number | null = null;
  private attachedConnectionGeneration = 0;
  private pendingLaunch: PendingTerminalLaunch | null = null;
  private serverGeneration: number | null = null;
  private lastSequence = 0;
  private replaying = false;
  private onInput: (() => void) | null = null;
  private terminalInputOriginArmed = false;
  private terminalInputOriginEpoch = 0;
  private disposed = false;
  private autoConnect = true;
  private sessionWasPresent = false;
  private readonly unsubscribeSessionStore: (() => void) | null;

  constructor(private readonly options: TerminalSurfaceOptions) {
    this.theme = { ...options.theme };
    this.appearanceMode = options.appearanceMode;
    this.state = { ...this.state, appearanceMode: options.appearanceMode };
    this.fontSize = options.fontSize;
    this.actualTerminalId = options.terminalId;
    this.unsubscribeMessages = wsClient.subscribeServerMessages((message) => {
      this.handleServerMessage(message);
    });
    this.sessionWasPresent = Boolean(
      options.sessionId && useSessionStore.getState().getSession(options.sessionId),
    );
    this.unsubscribeSessionStore = options.sessionId
      ? useSessionStore.subscribe((state) => {
          const present = Boolean(state.getSession(options.sessionId!));
          if (this.sessionWasPresent && !present) {
            // The REST/WS session-close path owns PTY termination. This only
            // releases the renderer surface and its subscriber.
            this.dispose();
            return;
          }
          if (present) this.sessionWasPresent = true;
        })
      : null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TerminalSurfaceSnapshot => this.state;

  setTheme(theme: TesseraTerminalTheme, mode: TerminalColorSchemeMode): void {
    this.requestedTheme = { theme: { ...theme }, mode };
    if (this.attachedConnectionGeneration > 0 && this.state.status === 'running') {
      const sent = wsClient.setTerminalAppearance(
        this.actualTerminalId,
        this.surfaceId,
        this.toAppearance(theme, mode),
      );
      if (sent) return;
    }
    this.applyTheme(theme, mode);
    this.setThemeRestartRequired(false);
  }

  restartForTheme(): void {
    if (
      this.disposed
      || !this.requestedTheme
      || !this.state.themeRestartRequired
      || !this.state.themeRestartAllowed
    ) return;
    const { theme, mode } = this.requestedTheme;
    this.applyTheme(theme, mode);
    this.setThemeRestartRequired(false);
    this.themeRestartPending = true;
    this.autoConnect = true;
    this.replaying = false;
    this.updateState('starting', 'Restarting terminal to apply theme...');
    wsClient.closeTerminal(this.actualTerminalId);
  }

  setFontSize(fontSize: number): void {
    if (this.fontSize === fontSize) return;
    this.fontSize = fontSize;
    if (!this.terminal) return;
    this.terminal.options.fontSize = fontSize;
    this.requestStableFit(false);
  }

  setInputListener(listener: (() => void) | null): void {
    this.onInput = listener;
  }

  async mount(host: HTMLElement): Promise<void> {
    if (this.disposed) return;
    this.cancelColdPark();
    this.intendedHost = host;
    if (!(await this.initialize())) return;
    if (this.disposed || this.intendedHost !== host || !this.root || !this.fitAddon) return;

    host.appendChild(this.root);
    this.mountedHost = host;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.requestStableFit(false);
      if (this.resizeSettleTimerId !== null) window.clearTimeout(this.resizeSettleTimerId);
      this.resizeSettleTimerId = window.setTimeout(() => {
        this.resizeSettleTimerId = null;
        this.requestStableFit(false);
      }, TERMINAL_RESIZE_SETTLE_DELAY_MS);
    });
    this.resizeObserver.observe(host);

    requestAnimationFrame(() => {
      if (this.mountedHost !== host) return;
      this.requestStableFit(false);
    });
  }

  unmount(host: HTMLElement): void {
    if (this.intendedHost === host) this.intendedHost = null;
    if (this.mountedHost !== host) return;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelPendingFit();
    this.scrollController?.cancelPendingRestore();
    this.mountedHost = null;
    if (this.root && !this.disposed) {
      getParkingLot().appendChild(this.root);
    }
    this.scheduleColdPark();
  }

  async ensureConnected(): Promise<boolean> {
    if (this.disposed || !this.autoConnect) return false;
    if (!(await this.initialize()) || this.disposed) return false;

    const connectionGeneration = wsClient.getConnectionGeneration();
    if (
      connectionGeneration > 0
      && this.attachedConnectionGeneration === connectionGeneration
    ) {
      return true;
    }

    const dimensions = this.getDimensions();
    const pendingLaunch = takePendingTerminalLaunch(this.options.terminalId);
    if (pendingLaunch) this.pendingLaunch = pendingLaunch;
    if (pendingLaunch?.locksSourceSession && pendingLaunch.intent) {
      this.themeRestartLaunchIntent = pendingLaunch.intent;
    }
    const sent = wsClient.createTerminal({
      terminalId: this.actualTerminalId,
      surfaceId: this.surfaceId,
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      cols: dimensions?.cols,
      rows: dimensions?.rows,
      appearance: {
        mode: this.appearanceMode,
        foreground: this.theme.foreground,
        background: this.theme.background,
      },
      launchIntent: pendingLaunch?.intent,
      prefillInput: pendingLaunch?.prefillInput,
      launch: pendingLaunch?.launch ?? this.options.launch,
      previewOwnerToken: this.options.previewOwned ? this.surfaceId : undefined,
    });

    if (!sent) {
      if (pendingLaunch) {
        setPendingTerminalLaunch(this.options.terminalId, pendingLaunch);
        this.pendingLaunch = null;
      }
      this.updateState('starting', 'Waiting for server connection...');
      return false;
    }

    this.attachedConnectionGeneration = connectionGeneration;
    this.updateState('starting', 'Connecting terminal...');
    return true;
  }

  sendInput(data: string): boolean {
    if (this.disposed || this.replaying || this.state.status === 'exited') return false;
    return wsClient.sendTerminalInput(this.actualTerminalId, this.surfaceId, data);
  }

  /** Ask the server to close only a runtime created by this preview token. */
  releasePreviewRuntime(): void {
    if (this.disposed) return;
    wsClient.releasePreviewTerminal({
      terminalId: this.actualTerminalId,
      sessionId: this.options.sessionId,
      previewOwnerToken: this.surfaceId,
    });
    this.dispose();
  }

  disposeIfUnmounted(): void {
    if (this.mountedHost === null) this.dispose();
  }

  scrollToBottom(): void {
    this.scrollController?.scrollToBottom();
  }

  matchesTerminal(terminalId: string): boolean {
    return this.options.terminalId === terminalId || this.actualTerminalId === terminalId;
  }

  resetWebglTextureAtlas(): void {
    this.webglAddon?.clearTextureAtlas();
  }

  refreshTerminalViewport(): void {
    if (!this.terminal) return;
    this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
  }

  close(): void {
    if (this.disposed) return;
    this.autoConnect = false;
    clearClientTerminalHandoff(this.options.terminalId);
    wsClient.closeTerminal(this.actualTerminalId);
    this.attachedConnectionGeneration = 0;
    this.updateState('exited', 'Terminal closed');
  }

  async restart(): Promise<boolean> {
    if (this.disposed) return false;
    this.autoConnect = true;
    this.serverGeneration = null;
    this.lastSequence = 0;
    this.replaying = false;
    this.terminal?.reset();
    this.scrollController?.scrollToBottom();
    this.updateState('starting', 'Restarting terminal...');
    return this.ensureConnected();
  }

  /**
   * Tracks whether this surface's tab is the active one. LRU keeps up to
   * five inactive tabs mounted (visibility: hidden) rather than unmounting
   * them, so `mount`/`unmount` never fire on a tab switch — this is the
   * signal that actually starts/cancels the cold-park timer for that case.
   */
  setHostVisible(visible: boolean): void {
    if (this.disposed) return;
    if (!visible) {
      this.scheduleColdPark();
      return;
    }
    this.cancelColdPark();
    if (!this.terminal && this.mountedHost) void this.mount(this.mountedHost);
    requestAnimationFrame(() => {
      if (!this.disposed && this.isMountedHostVisible()) recoverAllTerminalRenderers();
    });
  }

  activate(): void {
    if (this.disposed || !this.isMountedHostVisible()) return;
    requestAnimationFrame(() => {
      if (!this.isMountedHostVisible()) return;
      this.requestStableFit(true);
      this.terminal?.focus();
    });
  }

  dispose(options: { detach?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelColdPark();
    if (options.detach !== false && this.attachedConnectionGeneration > 0) {
      wsClient.detachTerminal(this.actualTerminalId, this.surfaceId);
    }
    this.unsubscribeMessages();
    this.unsubscribeSessionStore?.();
    this.releaseRenderResources();
    if (surfaces.get(this.options.registryKey) === this) {
      surfaces.delete(this.options.registryKey);
    }
  }

  /**
   * Releases xterm/WebGL/DOM resources for a surface whose tab has been
   * hidden for COLD_PARK_DELAY_MS, without disposing the surface itself:
   * the server-side PTY detaches from this surface but keeps running,
   * `mountedHost` is left in place, and the surface stays registered.
   * `setHostVisible(true)` reinitializes and reattaches, replaying the
   * terminal_snapshot the server already holds for the still-live PTY.
   */
  private coldPark(): void {
    if (this.disposed || !this.terminal) return;
    if (this.attachedConnectionGeneration > 0) {
      wsClient.detachTerminal(this.actualTerminalId, this.surfaceId);
      this.attachedConnectionGeneration = 0;
    }
    this.releaseRenderResources();
  }

  private releaseRenderResources(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelPendingFit();
    this.cancelScheduledScrollSync();
    this.cancelScheduledSurfaceScrollStateSync();
    if (this.scrollRebuildSettleTimerId !== null) {
      window.clearTimeout(this.scrollRebuildSettleTimerId);
      this.scrollRebuildSettleTimerId = null;
    }
    this.inputDisposable?.dispose();
    this.inputDisposable = null;
    this.scrollDisposable?.dispose();
    this.scrollDisposable = null;
    this.scrollTrackingCleanup?.();
    this.scrollTrackingCleanup = null;
    this.unsubscribeScrollController?.();
    this.unsubscribeScrollController = null;
    this.scrollController?.dispose();
    this.scrollController = null;
    if (this.root && this.pasteListener) {
      this.root.removeEventListener('paste', this.pasteListener, true);
    }
    this.pasteListener = null;
    if (this.root && this.compositionEndListener) {
      this.root.removeEventListener('compositionend', this.compositionEndListener, true);
    }
    this.compositionEndListener = null;
    try {
      this.webglAddon?.dispose();
    } catch {
      // A lost WebGL context may already have torn the addon down.
    }
    this.webglAddon = null;
    this.fitAddon?.dispose?.();
    this.fitAddon = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.root?.remove();
    this.root = null;
  }

  private async initialize(): Promise<boolean> {
    if (this.terminal) return true;
    if (this.disposed) return false;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.initializeTerminal()
      .then(() => Boolean(this.terminal && !this.disposed))
      .catch(() => false);
    try {
      return await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  private async initializeTerminal(): Promise<void> {
    try {
      const [
        { Terminal },
        { FitAddon },
        { WebglAddon },
        { Unicode11Addon },
        { WebLinksAddon },
        { SearchAddon },
        { SerializeAddon },
      ] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-webgl'),
        import('@xterm/addon-unicode11'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-search'),
        import('@xterm/addon-serialize'),
      ]);
      if (this.disposed) return;

      const root = document.createElement('div');
      root.className = 'tessera-terminal-surface h-full min-h-0 overflow-hidden';
      getParkingLot().appendChild(root);

      const { webLinkHandler, oscLinkHandler } = createTerminalExternalLinkHandlers();
      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        allowProposedApi: true,
        minimumContrastRatio: 4.5,
        scrollback: 5_000,
        scrollbar: {
          showScrollbar: true,
          width: 7,
        },
        fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: this.fontSize,
        theme: this.theme,
        linkHandler: oscLinkHandler,
      }) as XtermLike;

      terminal.open(root);
      const fitAddon = new FitAddon() as FitAddonLike;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new SearchAddon());
      terminal.loadAddon(new SerializeAddon());
      terminal.loadAddon(new Unicode11Addon());
      terminal.loadAddon(new WebLinksAddon(webLinkHandler));
      terminal.unicode.activeVersion = '11';
      attachTerminalMouseWheelMultiplier(terminal);

      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          try {
            webglAddon.dispose();
          } catch {
            // already torn down
          }
          if (this.webglAddon === webglAddon) this.webglAddon = null;

          // DOM and WebGL renderers can calculate slightly different cell
          // metrics. Wait until the DOM renderer owns the screen, then refit
          // the stable grid so panel bounds and PTY dimensions stay aligned.
          requestAnimationFrame(() => {
            if (this.disposed || this.terminal !== terminal) return;
            this.fitAndResize(false, true);
            try {
              terminal.refresh(0, Math.max(0, terminal.rows - 1));
            } catch {
              // The renderer may be torn down during the recovery frame.
            }
          });
        });
        terminal.loadAddon(webglAddon);
        this.webglAddon = webglAddon;
      } catch (error) {
        console.warn('[terminal] WebGL unavailable — using DOM renderer', error);
      }

      this.root = root;
      this.terminal = terminal;
      this.fitAddon = fitAddon;
      const scrollController = new TerminalScrollController(terminal);
      this.scrollController = scrollController;
      this.unsubscribeScrollController = scrollController.subscribe(() => {
        this.syncScrollStateFromController();
      });
      this.scrollTrackingCleanup = this.attachScrollTracking(root, scrollController);
      const inputContext = {
        platform: detectTerminalClientPlatform(navigator.userAgent),
      } as const;
      const electronClipboard = (
        window as Window & { electronAPI?: Partial<ElectronTerminalClipboardApi> }
      ).electronAPI;
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          event.type === 'keydown'
          && event.shiftKey
          && !event.metaKey
          && !event.ctrlKey
          && !event.altKey
        ) {
          if (event.key === 'PageUp') {
            scrollController.pinViewport();
            this.scheduleScrollIntentSync(scrollController, true);
          } else if (event.key === 'PageDown') {
            this.scheduleScrollIntentSync(scrollController, false);
          }
        }

        if (
          typeof electronClipboard?.getTerminalClipboardKind === 'function'
          && typeof electronClipboard.readTerminalClipboard === 'function'
          && isTerminalPasteShortcut(event, inputContext.platform)
          && electronClipboard.getTerminalClipboardKind() === 'image'
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.notifyTerminalInput();
          this.enqueueClipboardPaste(() => (
            this.pasteDesktopClipboard(terminal, electronClipboard as ElectronTerminalClipboardApi)
          ));
          return false;
        }

        const action = resolveTerminalInputAction(event, inputContext);
        if (action === null) {
          if (event.type === 'keydown' && !event.isComposing && !isModifierOnlyKey(event.key)) {
            this.armTerminalInputOrigin();
          }
          return true;
        }

        event.preventDefault();
        event.stopPropagation();
        if (action.type === 'send-input') {
          this.notifyTerminalInput();
          this.sendInput(action.data);
        } else if (action.position === 'top') {
          scrollController.scrollToTop();
        } else {
          scrollController.scrollToBottom();
        }
        return false;
      });
      this.inputDisposable = terminal.onData((data) => {
        if (this.terminalInputOriginArmed) {
          this.terminalInputOriginArmed = false;
          this.notifyTerminalInput();
        }
        this.sendInput(data);
      });
      this.scrollDisposable = terminal.onScroll(() => {
        scrollController.notifyViewportChanged();
        this.scheduleSurfaceScrollStateSync();
      });
      this.syncScrollStateFromController();
      this.pasteListener = (event) => {
        if (event.clipboardData?.getData('text/plain')) {
          this.armTerminalInputOrigin();
          return;
        }
        const imageFile = Array.from(event.clipboardData?.items ?? [])
          .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
          ?.getAsFile();
        if (!imageFile) return;

        event.preventDefault();
        event.stopPropagation();
        this.notifyTerminalInput();
        this.enqueueClipboardPaste(() => this.pasteBrowserClipboardImage(terminal, imageFile));
      };
      root.addEventListener('paste', this.pasteListener, true);
      this.compositionEndListener = (event) => {
        if (event.data) this.notifyTerminalInput();
      };
      root.addEventListener('compositionend', this.compositionEndListener, true);
    } catch (error) {
      this.updateState(
        'error',
        error instanceof Error ? error.message : 'Terminal failed to load.',
      );
      throw error;
    }
  }

  private async pasteDesktopClipboard(
    terminal: XtermLike,
    electronClipboard: ElectronTerminalClipboardApi,
  ): Promise<void> {
    const payload = await electronClipboard.readTerminalClipboard();
    if (this.disposed || this.terminal !== terminal) return;
    await pasteTerminalClipboard(payload, {
      paste: (data) => {
        if (!this.disposed && this.terminal === terminal) terminal.paste(data);
      },
      uploadImage: uploadTerminalClipboardImage,
    });
  }

  private async pasteBrowserClipboardImage(terminal: XtermLike, file: File): Promise<void> {
    const uploadedPath = await uploadTerminalClipboardFile(file);
    if (!this.disposed && this.terminal === terminal) terminal.paste(uploadedPath);
  }

  private enqueueClipboardPaste(operation: () => Promise<void>): void {
    this.clipboardPasteQueue = this.clipboardPasteQueue
      .then(async () => {
        if (!this.disposed) await operation();
      })
      .catch((error: unknown) => {
        this.reportClipboardPasteError(error);
      });
  }

  private notifyTerminalInput(): void {
    this.onInput?.();
  }

  private armTerminalInputOrigin(): void {
    this.terminalInputOriginArmed = true;
    const epoch = ++this.terminalInputOriginEpoch;
    queueMicrotask(() => {
      if (this.terminalInputOriginEpoch === epoch) {
        this.terminalInputOriginArmed = false;
      }
    });
  }

  private reportClipboardPasteError(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : 'Failed to paste clipboard image.';
    console.warn('[terminal] Clipboard paste failed', error);
    useNotificationStore.getState().showToast(message, 'error');
  }

  private handleServerMessage(message: ServerTransportMessage): void {
    if (this.disposed || !('terminalId' in message)) return;

    if (message.terminalId === this.actualTerminalId && message.type === 'terminal_prefill_written') {
      this.finishPendingLaunch('started');
      return;
    }

    if (message.terminalId === this.actualTerminalId && message.type === 'terminal_prefill_cancelled') {
      this.finishPendingLaunch('error', message.message);
      return;
    }

    if (message.type === 'terminal_error') {
      const surfaceMatches = message.surfaceId
        ? message.surfaceId === this.surfaceId
        : message.terminalId === this.actualTerminalId;
      if (!surfaceMatches) return;
      this.autoConnect = false;
      this.attachedConnectionGeneration = 0;
      clearClientTerminalHandoff(this.options.terminalId);
      this.updateState('error', message.message);
      this.finishPendingLaunch('error', message.message);
      return;
    }

    if (!('surfaceId' in message) || message.surfaceId !== this.surfaceId) return;

    if (message.type === 'terminal_started') {
      this.actualTerminalId = message.terminalId;
      if (this.serverGeneration !== message.generation) {
        this.serverGeneration = message.generation;
        this.lastSequence = 0;
      }
      if (message.appearance) this.applyServerAppearance(message.appearance);
      this.updateState('running', `${message.shell} - ${message.cwd}`);
      const requested = this.requestedTheme;
      if (
        requested
        && message.appearance
        && (
          requested.mode !== message.appearance.mode
          || requested.theme.foreground !== message.appearance.foreground
          || requested.theme.background !== message.appearance.background
        )
      ) {
        wsClient.setTerminalAppearance(
          this.actualTerminalId,
          this.surfaceId,
          this.toAppearance(requested.theme, requested.mode),
        );
      }
      return;
    }

    if (message.type === 'terminal_appearance') {
      if (message.restartIntent) this.themeRestartLaunchIntent = message.restartIntent;
      this.applyServerAppearance(message.appearance);
      const hasSafeRestartRecipe = Boolean(this.options.launch || this.themeRestartLaunchIntent);
      this.setThemeRestartState(
        message.restartRequired,
        message.restartAllowed && hasSafeRestartRecipe,
      );
      if (!message.restartRequired) this.requestedTheme = null;
      return;
    }

    if (message.type === 'terminal_snapshot') {
      if (
        this.serverGeneration !== null
        && message.generation !== this.serverGeneration
      ) return;
      this.serverGeneration = message.generation;
      this.lastSequence = message.seq;
      this.replaying = true;
      const restorePoint = this.scrollController?.captureRestorePoint();
      const shouldRecoverRenderer = this.backgroundSgrDetector.consume(message.data);
      this.terminal?.reset();
      this.terminal?.write(message.data, () => {
        if (restorePoint) this.scrollController?.restore(restorePoint);
        this.scheduleScrollRebuildSettle();
        if (this.serverGeneration === message.generation) {
          this.replaying = false;
        }
        this.scheduleSurfaceScrollStateSync();
        if (shouldRecoverRenderer) this.recoverRendererPresentation();
      });
      return;
    }

    if (message.type === 'terminal_output') {
      if (message.generation !== this.serverGeneration || message.seq <= this.lastSequence) return;
      this.lastSequence = message.seq;
      const restorePoint = this.scrollController?.captureRestorePoint();
      const shouldRecoverRenderer = this.backgroundSgrDetector.consume(message.data);
      this.terminal?.write(message.data, () => {
        if (restorePoint) this.scrollController?.restore(restorePoint);
        this.scheduleScrollRebuildSettle();
        this.scheduleSurfaceScrollStateSync();
        if (shouldRecoverRenderer) this.recoverRendererPresentation();
      });
      return;
    }

    if (message.type === 'terminal_exit') {
      if (message.generation !== this.serverGeneration) return;
      this.attachedConnectionGeneration = 0;
      if (this.themeRestartPending) {
        this.themeRestartPending = false;
        if (this.themeRestartLaunchIntent) {
          setPendingTerminalLaunch(this.options.terminalId, {
            intent: this.themeRestartLaunchIntent,
            locksSourceSession: true,
          });
        }
        this.serverGeneration = null;
        this.lastSequence = 0;
        this.replaying = false;
        this.terminal?.reset();
        this.scrollController?.scrollToBottom();
        void this.ensureConnected();
        return;
      }
      this.autoConnect = false;
      this.replaying = false;
      clearClientTerminalHandoff(this.options.terminalId);
      this.updateState('exited', `Terminal exited with code ${message.exitCode}`);
      this.finishPendingLaunch('error', `Terminal exited with code ${message.exitCode}`);
    }
  }

  private recoverRendererPresentation(): void {
    // A synchronous repaint repairs stale cells immediately. The shared atlas
    // reset waits for output/resize activity to settle so it cannot flicker.
    try {
      this.refreshTerminalViewport();
    } finally {
      sharedTerminalRenderRecovery.request();
    }
  }

  private finishPendingLaunch(status: 'started' | 'error', message?: string): void {
    const pendingLaunch = this.pendingLaunch;
    if (!pendingLaunch) return;
    this.pendingLaunch = null;
    if (status === 'error' && !pendingLaunch.locksSourceSession) {
      clearClientTerminalHandoff(this.options.terminalId);
    }
    if (!pendingLaunch.sourceSessionId || !pendingLaunch.intent) return;
    dispatchTerminalLaunchResult({
      terminalId: this.options.terminalId,
      sourceSessionId: pendingLaunch.sourceSessionId,
      commandInput: pendingLaunch.intent.commandInput,
      status,
      ...(message ? { message } : {}),
    });
  }

  private attachScrollTracking(
    root: HTMLElement,
    controller: TerminalScrollController,
  ): () => void {
    let pointerScrollActive = false;
    const isScrollbarTarget = (target: EventTarget | null): boolean => (
      target instanceof Element
      && target.closest('.xterm-viewport, .xterm-scrollbar, .xterm-slider') !== null
    );
    const onWheel = (event: WheelEvent) => {
      // A mouse-reporting TUI (Claude Code select prompts, ...) owns this
      // wheel: xterm sends it to the PTY as mouse reports and never moves
      // the viewport. Pinning here would silently break follow-output.
      if (isTerminalTuiOwnedWheelEvent(event, this.terminal?.element)) return;
      if (event.deltaY < 0) controller.pinViewport();
      this.scheduleScrollIntentSync(controller, event.deltaY < 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerScrollActive = isScrollbarTarget(event.target);
    };
    const onPointerDone = () => {
      if (!pointerScrollActive) return;
      pointerScrollActive = false;
      controller.syncFromViewport();
    };
    const onScroll = () => {
      controller.notifyViewportChanged();
      if (pointerScrollActive) controller.syncFromViewport();
    };

    root.addEventListener('wheel', onWheel, { capture: true, passive: true });
    root.addEventListener('pointerdown', onPointerDown, true);
    root.addEventListener('scroll', onScroll, true);
    window.addEventListener('pointerup', onPointerDone, true);
    window.addEventListener('pointercancel', onPointerDone, true);
    return () => {
      root.removeEventListener('wheel', onWheel, true);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pointerup', onPointerDone, true);
      window.removeEventListener('pointercancel', onPointerDone, true);
    };
  }

  private scheduleScrollIntentSync(
    controller: TerminalScrollController,
    preservePinnedAtBottom: boolean,
  ): void {
    scheduleTerminalScrollIntentSync(
      controller,
      this.scrollSyncSettler,
      preservePinnedAtBottom,
      () => !this.disposed && this.scrollController === controller,
    );
  }

  private cancelScheduledScrollSync(): void {
    this.scrollSyncSettler.cancel();
  }

  private requestStableFit(claim: boolean): void {
    this.pendingFitClaim ||= claim;
    if (this.pendingFitFrameId !== null || !this.isMountedHostVisible()) return;

    let previous = this.getProposedDimensions();
    let frameCount = 0;
    const waitForStableGrid = () => {
      this.pendingFitFrameId = requestAnimationFrame(() => {
        this.pendingFitFrameId = null;
        if (!this.isMountedHostVisible() || !this.terminal) {
          this.pendingFitClaim = false;
          return;
        }

        const next = this.getProposedDimensions();
        frameCount += 1;
        const matchesTerminal = next
          && next.cols === this.terminal.cols
          && next.rows === this.terminal.rows;
        const dimensionsStable = next
          && previous
          && next.cols === previous.cols
          && next.rows === previous.rows;
        if (!next || matchesTerminal || dimensionsStable || frameCount >= 8) {
          const pendingClaim = this.pendingFitClaim;
          this.pendingFitClaim = false;
          this.fitAndResize(pendingClaim, !matchesTerminal);
          return;
        }

        previous = next;
        waitForStableGrid();
      });
    };
    waitForStableGrid();
  }

  private scheduleColdPark(): void {
    if (this.coldParkTimerId !== null || this.disposed) return;
    this.coldParkTimerId = window.setTimeout(() => {
      this.coldParkTimerId = null;
      this.coldPark();
    }, COLD_PARK_DELAY_MS);
  }

  private cancelColdPark(): void {
    if (this.coldParkTimerId === null) return;
    window.clearTimeout(this.coldParkTimerId);
    this.coldParkTimerId = null;
  }

  private cancelPendingFit(): void {
    if (this.pendingFitFrameId !== null) cancelAnimationFrame(this.pendingFitFrameId);
    this.pendingFitFrameId = null;
    this.pendingFitClaim = false;
    if (this.resizeSettleTimerId !== null) window.clearTimeout(this.resizeSettleTimerId);
    this.resizeSettleTimerId = null;
  }

  private fitAndResize(claim: boolean, shouldFit = true): void {
    if (!this.isMountedHostVisible() || !this.fitAddon || !this.terminal) return;
    let didFit = false;
    let restorePoint: TerminalScrollRestorePoint | null = null;
    try {
      if (shouldFit) {
        restorePoint = this.scrollController?.captureRestorePoint() ?? null;
        this.fitAddon.fit();
        didFit = true;
      }
      const dimensions = this.getDimensions();
      if (dimensions && this.attachedConnectionGeneration > 0) {
        wsClient.resizeTerminal(
          this.actualTerminalId,
          this.surfaceId,
          dimensions.cols,
          dimensions.rows,
          claim,
        );
      }
    } catch {
      // A zero-sized panel can briefly make FitAddon unable to calculate cells.
    } finally {
      if (restorePoint) this.scrollController?.restoreAfterLayout(restorePoint);
      this.scheduleSurfaceScrollStateSync();
      // WebGL can finish a rapid resize with the correct xterm buffer but an
      // empty presentation model. Force the same full repaint and quiet atlas
      // recovery Orca uses for stale terminal presentation.
      if (didFit) this.recoverRendererPresentation();
    }
  }

  private isMountedHostVisible(): boolean {
    if (!this.mountedHost?.isConnected) return false;
    if (this.mountedHost.closest('[aria-hidden="true"]')) return false;
    const rect = this.mountedHost.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private getDimensions(): { cols: number; rows: number } | undefined {
    return this.fitAddon?.proposeDimensions()
      ?? (this.terminal ? { cols: this.terminal.cols, rows: this.terminal.rows } : undefined);
  }

  private getProposedDimensions(): { cols: number; rows: number } | undefined {
    try {
      return this.fitAddon?.proposeDimensions();
    } catch {
      return undefined;
    }
  }

  private updateState(status: TerminalSurfaceStatus, subtitle: string): void {
    if (this.state.status === status && this.state.subtitle === subtitle) return;
    this.state = { ...this.state, status, subtitle };
    this.notifyListeners();
  }

  private toAppearance(
    theme: TesseraTerminalTheme,
    mode: TerminalColorSchemeMode,
  ): TerminalAppearance {
    return {
      mode,
      foreground: theme.foreground,
      background: theme.background,
    };
  }

  private applyServerAppearance(appearance: TerminalAppearance): void {
    const requested = this.requestedTheme?.mode === appearance.mode
      && this.requestedTheme.theme.foreground === appearance.foreground
      && this.requestedTheme.theme.background === appearance.background
      ? this.requestedTheme.theme
      : null;
    const matchingPreset = getTerminalThemePresets(appearance.mode).find(({ theme }) => (
      theme.foreground === appearance.foreground
      && theme.background === appearance.background
    ));
    this.applyTheme(
      requested ?? matchingPreset?.theme ?? getTerminalTheme(appearance.mode === 'dark'),
      appearance.mode,
    );
  }

  private applyTheme(theme: TesseraTerminalTheme, mode: TerminalColorSchemeMode): void {
    this.theme = { ...theme };
    this.appearanceMode = mode;
    if (this.terminal) this.terminal.options.theme = this.theme;
    if (this.state.appearanceMode !== mode) {
      this.state = { ...this.state, appearanceMode: mode };
      this.notifyListeners();
    }
  }

  private setThemeRestartRequired(themeRestartRequired: boolean): void {
    this.setThemeRestartState(themeRestartRequired, false);
  }

  private setThemeRestartState(themeRestartRequired: boolean, themeRestartAllowed: boolean): void {
    if (
      this.state.themeRestartRequired === themeRestartRequired
      && this.state.themeRestartAllowed === themeRestartAllowed
    ) return;
    this.state = { ...this.state, themeRestartRequired, themeRestartAllowed };
    this.notifyListeners();
  }

  private syncScrollStateFromController(): void {
    const isAtBottom = this.scrollController?.getSnapshot().isAtBottom ?? true;
    if (this.state.isAtBottom === isAtBottom) return;
    this.state = { ...this.state, isAtBottom };
    this.notifyListeners();
  }

  private scheduleSurfaceScrollStateSync(): void {
    if (this.pendingScrollStateFrameId !== null || this.disposed) return;
    this.pendingScrollStateFrameId = requestAnimationFrame(() => {
      this.pendingScrollStateFrameId = null;
      if (!this.disposed) this.syncScrollStateFromController();
    });
  }

  private scheduleScrollRebuildSettle(): void {
    if (this.scrollRebuildSettleTimerId !== null) {
      window.clearTimeout(this.scrollRebuildSettleTimerId);
    }
    this.scrollRebuildSettleTimerId = window.setTimeout(() => {
      this.scrollRebuildSettleTimerId = null;
      this.scrollController?.finishBufferRebuild();
    }, TERMINAL_RESIZE_SETTLE_DELAY_MS);
  }

  private cancelScheduledSurfaceScrollStateSync(): void {
    if (this.pendingScrollStateFrameId !== null) {
      cancelAnimationFrame(this.pendingScrollStateFrameId);
    }
    this.pendingScrollStateFrameId = null;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}

export function getTerminalSurface(options: TerminalSurfaceOptions): TerminalSurface {
  const existing = surfaces.get(options.registryKey);
  if (existing) return existing;
  const surface = new TerminalSurface(options);
  surfaces.set(options.registryKey, surface);
  return surface;
}

export function closeAndDisposeTerminalSurface(surface: TerminalSurface): void {
  surface.close();
  surface.dispose({ detach: false });
}

/** Send through an already-attached surface, preferring the visible/running one. */
export function sendInputToTerminal(terminalId: string, data: string): boolean {
  const candidates = [...surfaces.values()].filter((surface) => surface.matchesTerminal(terminalId));
  for (const surface of candidates) {
    if (surface.getSnapshot().status === 'running' && surface.sendInput(data)) return true;
  }
  return candidates.some((surface) => surface.sendInput(data));
}

export function getSessionTerminalId(sessionId: string): string {
  return `session-${sessionId}`;
}
