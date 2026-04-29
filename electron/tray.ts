import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';

let tray: Tray | null = null;

function getTrayIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'tray-icon.png';
  return path.join(app.getAppPath(), 'assets', iconName);
}

export function createTray(win: BrowserWindow, onQuit: () => void): void {
  const iconPath = getTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);

  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Tessera');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Tessera',
      click: () => {
        win.show();
        win.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: onQuit,
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Windows/Linux: left-click toggles window
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    });
  }
}
