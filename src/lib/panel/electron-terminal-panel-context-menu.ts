import type { PanelSplitPlacement } from './panel-split';

export interface TerminalPanelSplitRequest {
  panelId: string;
  placement: PanelSplitPlacement;
}

type TerminalPanelSplitListener = (request: TerminalPanelSplitRequest) => void;

interface ElectronTerminalPanelContextMenuApi {
  onTerminalPanelSplitRequested?: (
    callback: TerminalPanelSplitListener,
  ) => (() => void) | void;
  onTerminalPanelViewModeRequested?: (
    callback: (request: { panelId: string; mode: 'terminal' | 'chat' }) => void,
  ) => (() => void) | void;
}

const listeners = new Set<TerminalPanelSplitListener>();
let releaseElectronListener: (() => void) | null = null;
const viewModeListeners = new Set<(
  request: { panelId: string; mode: 'terminal' | 'chat' },
) => void>();
let releaseViewModeElectronListener: (() => void) | null = null;

function getElectronApi(): ElectronTerminalPanelContextMenuApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronTerminalPanelContextMenuApi }).electronAPI;
}

function dispatchRequest(request: TerminalPanelSplitRequest): void {
  for (const listener of listeners) listener(request);
}

/** Keep one ipcRenderer listener per renderer, regardless of mounted terminal count. */
export function subscribeToTerminalPanelSplitRequests(
  listener: TerminalPanelSplitListener,
): () => void {
  listeners.add(listener);

  if (listeners.size === 1) {
    const release = getElectronApi()?.onTerminalPanelSplitRequested?.(dispatchRequest);
    releaseElectronListener = typeof release === 'function' ? release : null;
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      releaseElectronListener?.();
      releaseElectronListener = null;
    }
  };
}

export function subscribeToTerminalPanelViewModeRequests(
  listener: (request: { panelId: string; mode: 'terminal' | 'chat' }) => void,
): () => void {
  viewModeListeners.add(listener);

  if (viewModeListeners.size === 1) {
    const release = getElectronApi()?.onTerminalPanelViewModeRequested?.((request) => {
      for (const currentListener of viewModeListeners) currentListener(request);
    });
    releaseViewModeElectronListener = typeof release === 'function' ? release : null;
  }

  return () => {
    viewModeListeners.delete(listener);
    if (viewModeListeners.size === 0) {
      releaseViewModeElectronListener?.();
      releaseViewModeElectronListener = null;
    }
  };
}
