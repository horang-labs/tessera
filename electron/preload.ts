import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  onWindowCloseRequest: (callback: (payload: { requestId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId?: string }) => {
      if (typeof payload?.requestId === 'string') {
        callback({ requestId: payload.requestId });
      }
    };

    ipcRenderer.on('window-close-requested', listener);
    return () => {
      ipcRenderer.removeListener('window-close-requested', listener);
    };
  },
  respondWindowClose: (requestId: string, action: 'quit' | 'tray' | 'cancel') =>
    ipcRenderer.send('window-close-response', { requestId, action }),
  setWindowsCloseBehavior: (behavior: 'ask' | 'tray' | 'quit') =>
    ipcRenderer.send('windows-close-behavior-changed', behavior),
  setTitlebarTheme: (theme: 'light' | 'dark', options?: { dimmed?: boolean }) =>
    ipcRenderer.send('set-titlebar-theme', theme, options),
  popupTitlebarMenu: (
    section: 'file' | 'edit' | 'view' | 'window' | 'help',
    anchor: { x: number; y: number }
  ) => ipcRenderer.invoke('titlebar-popup-menu', section, anchor),
  openBoardWindow: (payload?: { projectDir?: string | null; collectionFilter?: string | null }) =>
    ipcRenderer.invoke('open-board-window', payload),
  closeBoardPopouts: () => ipcRenderer.invoke('close-board-popouts'),
  getPopoutState: () => ipcRenderer.invoke('get-popout-state'),
  onPopoutStateChanged: (callback: (count: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { count?: number }) => {
      if (typeof payload?.count === 'number') {
        callback(payload.count);
      }
    };
    ipcRenderer.on('popout-state-changed', listener);
    return () => {
      ipcRenderer.removeListener('popout-state-changed', listener);
    };
  },
  popoutOpenSession: (sessionId: string, action: 'preview' | 'pin' = 'preview') =>
    ipcRenderer.send('popout-open-session', { sessionId, action }),
  onPopoutOpenSession: (
    callback: (payload: { sessionId: string; action: 'preview' | 'pin' }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { sessionId?: string; action?: string }
    ) => {
      if (typeof payload?.sessionId !== 'string') return;
      const action: 'preview' | 'pin' = payload.action === 'pin' ? 'pin' : 'preview';
      callback({ sessionId: payload.sessionId, action });
    };
    ipcRenderer.on('popout-open-session', listener);
    return () => {
      ipcRenderer.removeListener('popout-open-session', listener);
    };
  },
  uiActiveSessionChanged: (sessionId: string | null) =>
    ipcRenderer.send('ui-active-session-changed', { sessionId }),
  onUiActiveSessionChanged: (callback: (sessionId: string | null) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { sessionId?: string | null }
    ) => {
      const value = payload?.sessionId;
      if (value !== null && typeof value !== 'string') return;
      callback(value ?? null);
    };
    ipcRenderer.on('ui-active-session-changed', listener);
    return () => {
      ipcRenderer.removeListener('ui-active-session-changed', listener);
    };
  },
  uiSelectedProjectChanged: (projectDir: string | null) =>
    ipcRenderer.send('ui-selected-project-changed', { projectDir }),
  onUiSelectedProjectChanged: (callback: (projectDir: string | null) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { projectDir?: string | null }
    ) => {
      const value = payload?.projectDir;
      if (value !== null && typeof value !== 'string') return;
      callback(value ?? null);
    };
    ipcRenderer.on('ui-selected-project-changed', listener);
    return () => {
      ipcRenderer.removeListener('ui-selected-project-changed', listener);
    };
  },
  onTitlebarMenuCommand: (callback: (command: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { command?: string }) => {
      if (typeof payload?.command === 'string') {
        callback(payload.command);
      }
    };

    ipcRenderer.on('titlebar-menu-command', listener);
    return () => {
      ipcRenderer.removeListener('titlebar-menu-command', listener);
    };
  },
});
