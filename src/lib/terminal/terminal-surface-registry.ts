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
  type TesseraTerminalTheme,
} from './terminal-theme';
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

export type TerminalSurfaceStatus = 'starting' | 'running' | 'exited' | 'error';

export interface TerminalSurfaceSnapshot {
  status: TerminalSurfaceStatus;
  subtitle: string;
}

export interface TerminalSurfaceOptions {
  registryKey: string;
  terminalId: string;
  cwd?: string | null;
  sessionId?: string | null;
  launch?: { providerId: string; sessionId: string };
}

type XtermLike = {
  cols: number;
  rows: number;
  options: { theme?: ITheme };
  unicode: { activeVersion: string };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  loadAddon(addon: unknown): void;
  open(element: HTMLElement): void;
  focus(): void;
  paste(data: string): void;
  write(data: string, callback?: () => void): void;
  reset(): void;
  refresh(start: number, end: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  onData(callback: (data: string) => void): { dispose(): void };
  dispose(): void;
};

type FitAddonLike = {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
  dispose?(): void;
};

const surfaces = new Map<string, TerminalSurface>();
let parkingLot: HTMLElement | null = null;

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
  };
  private actualTerminalId: string;
  private theme = getTerminalTheme(true);
  private terminal: XtermLike | null = null;
  private fitAddon: FitAddonLike | null = null;
  private webglAddon: { dispose(): void } | null = null;
  private inputDisposable: { dispose(): void } | null = null;
  private pasteListener: ((event: ClipboardEvent) => void) | null = null;
  private clipboardPasteQueue: Promise<void> = Promise.resolve();
  private root: HTMLDivElement | null = null;
  private intendedHost: HTMLElement | null = null;
  private mountedHost: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private initializePromise: Promise<boolean> | null = null;
  private attachedConnectionGeneration = 0;
  private pendingLaunch: PendingTerminalLaunch | null = null;
  private serverGeneration: number | null = null;
  private lastSequence = 0;
  private replaying = false;
  private disposed = false;
  private autoConnect = true;
  private sessionWasPresent = false;
  private readonly unsubscribeSessionStore: (() => void) | null;

  constructor(private readonly options: TerminalSurfaceOptions) {
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

  setTheme(theme: TesseraTerminalTheme): void {
    this.theme = { ...theme };
    if (!this.terminal) return;
    // xterm repaints its current buffer when the theme option changes; the
    // long-lived surface and its PTY attachment remain intact.
    this.terminal.options.theme = this.theme;
  }

  async mount(host: HTMLElement): Promise<void> {
    if (this.disposed) return;
    this.intendedHost = host;
    if (!(await this.initialize())) return;
    if (this.disposed || this.intendedHost !== host || !this.root || !this.fitAddon) return;

    host.appendChild(this.root);
    this.mountedHost = host;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.fitAndResize(false));
    this.resizeObserver.observe(host);

    requestAnimationFrame(() => {
      if (this.mountedHost !== host) return;
      this.fitAndResize(false);
    });
  }

  unmount(host: HTMLElement): void {
    if (this.intendedHost === host) this.intendedHost = null;
    if (this.mountedHost !== host) return;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mountedHost = null;
    if (this.root && !this.disposed) {
      getParkingLot().appendChild(this.root);
    }
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
    const sent = wsClient.createTerminal({
      terminalId: this.actualTerminalId,
      surfaceId: this.surfaceId,
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      cols: dimensions?.cols,
      rows: dimensions?.rows,
      launchIntent: pendingLaunch?.intent,
      prefillInput: pendingLaunch?.prefillInput,
      launch: pendingLaunch?.launch ?? this.options.launch,
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

  matchesTerminal(terminalId: string): boolean {
    return this.options.terminalId === terminalId || this.actualTerminalId === terminalId;
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
    this.updateState('starting', 'Restarting terminal...');
    return this.ensureConnected();
  }

  activate(): void {
    if (this.disposed || !this.isMountedHostVisible()) return;
    requestAnimationFrame(() => {
      if (!this.isMountedHostVisible()) return;
      this.fitAndResize(true);
      this.terminal?.focus();
    });
  }

  dispose(options: { detach?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    if (options.detach !== false && this.attachedConnectionGeneration > 0) {
      wsClient.detachTerminal(this.actualTerminalId, this.surfaceId);
    }
    this.unsubscribeMessages();
    this.unsubscribeSessionStore?.();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.inputDisposable?.dispose();
    this.inputDisposable = null;
    if (this.root && this.pasteListener) {
      this.root.removeEventListener('paste', this.pasteListener, true);
    }
    this.pasteListener = null;
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
    if (surfaces.get(this.options.registryKey) === this) {
      surfaces.delete(this.options.registryKey);
    }
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
      root.className = 'h-full min-h-0 overflow-hidden';
      getParkingLot().appendChild(root);

      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        allowProposedApi: true,
        scrollback: 5_000,
        fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        theme: this.theme,
      }) as XtermLike;

      terminal.open(root);
      const fitAddon = new FitAddon() as FitAddonLike;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new SearchAddon());
      terminal.loadAddon(new SerializeAddon());
      terminal.loadAddon(new Unicode11Addon());
      terminal.loadAddon(new WebLinksAddon((event: MouseEvent, uri: string) => {
        event.preventDefault();
        window.open(uri, '_blank', 'noopener,noreferrer');
      }));
      terminal.unicode.activeVersion = '11';

      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          try {
            webglAddon.dispose();
          } catch {
            // already torn down
          }
          this.webglAddon = null;
          try {
            this.terminal?.refresh(0, Math.max(0, (this.terminal?.rows ?? 1) - 1));
          } catch {
            // The surface may have been disposed while the context was lost.
          }
        });
        terminal.loadAddon(webglAddon);
        this.webglAddon = webglAddon;
      } catch (error) {
        console.warn('[terminal] WebGL unavailable — using DOM renderer', error);
      }

      this.root = root;
      this.terminal = terminal;
      this.fitAddon = fitAddon;
      const inputContext = {
        platform: detectTerminalClientPlatform(navigator.userAgent),
      } as const;
      const electronClipboard = (
        window as Window & { electronAPI?: Partial<ElectronTerminalClipboardApi> }
      ).electronAPI;
      terminal.attachCustomKeyEventHandler((event) => {
        if (
          typeof electronClipboard?.getTerminalClipboardKind === 'function'
          && typeof electronClipboard.readTerminalClipboard === 'function'
          && isTerminalPasteShortcut(event, inputContext.platform)
          && electronClipboard.getTerminalClipboardKind() === 'image'
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.enqueueClipboardPaste(() => (
            this.pasteDesktopClipboard(terminal, electronClipboard as ElectronTerminalClipboardApi)
          ));
          return false;
        }

        const action = resolveTerminalInputAction(event, inputContext);
        if (action === null) return true;

        event.preventDefault();
        event.stopPropagation();
        if (action.type === 'send-input') {
          this.sendInput(action.data);
        } else if (action.position === 'top') {
          terminal.scrollToTop();
        } else {
          terminal.scrollToBottom();
        }
        return false;
      });
      this.inputDisposable = terminal.onData((data) => {
        this.sendInput(data);
      });
      this.pasteListener = (event) => {
        if (event.clipboardData?.getData('text/plain')) return;
        const imageFile = Array.from(event.clipboardData?.items ?? [])
          .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
          ?.getAsFile();
        if (!imageFile) return;

        event.preventDefault();
        event.stopPropagation();
        this.enqueueClipboardPaste(() => this.pasteBrowserClipboardImage(terminal, imageFile));
      };
      root.addEventListener('paste', this.pasteListener, true);
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
      this.updateState('running', `${message.shell} - ${message.cwd}`);
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
      this.terminal?.reset();
      this.terminal?.write(message.data, () => {
        if (this.serverGeneration === message.generation) {
          this.replaying = false;
        }
      });
      return;
    }

    if (message.type === 'terminal_output') {
      if (message.generation !== this.serverGeneration || message.seq <= this.lastSequence) return;
      this.lastSequence = message.seq;
      this.terminal?.write(message.data);
      return;
    }

    if (message.type === 'terminal_exit') {
      if (message.generation !== this.serverGeneration) return;
      this.attachedConnectionGeneration = 0;
      this.autoConnect = false;
      this.replaying = false;
      clearClientTerminalHandoff(this.options.terminalId);
      this.updateState('exited', `Terminal exited with code ${message.exitCode}`);
      this.finishPendingLaunch('error', `Terminal exited with code ${message.exitCode}`);
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

  private fitAndResize(claim: boolean): void {
    if (!this.isMountedHostVisible() || !this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
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

  private updateState(status: TerminalSurfaceStatus, subtitle: string): void {
    if (this.state.status === status && this.state.subtitle === subtitle) return;
    this.state = { status, subtitle };
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
