import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  setTitlebarTheme: (theme: 'light' | 'dark', options?: { dimmed?: boolean }) =>
    ipcRenderer.send('set-titlebar-theme', theme, options),
  popupTitlebarMenu: (
    section: 'file' | 'edit' | 'view' | 'window' | 'help',
    anchor: { x: number; y: number }
  ) => ipcRenderer.invoke('titlebar-popup-menu', section, anchor),
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
