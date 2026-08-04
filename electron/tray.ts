import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import * as path from 'path';
import {
  formatRemoteAccessTrayLabel,
  type ElectronLanguage,
  type RemoteAccessStatus,
} from './remote-access-status';

let tray: Tray | null = null;

type WindowsCloseBehavior = 'ask' | 'tray' | 'quit';

interface TrayState {
  win: BrowserWindow;
  onQuit: () => void;
  closeBehavior: WindowsCloseBehavior;
  onCloseBehaviorChange: (behavior: WindowsCloseBehavior) => void;
  language: ElectronLanguage;
  remoteAccessStatus: RemoteAccessStatus | null;
}

let trayState: TrayState | null = null;

function getTrayIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'tray-icon.png';
  return path.join(app.getAppPath(), 'assets', iconName);
}

function buildContextMenu(state: TrayState): Menu {
  const {
    win,
    onQuit,
    closeBehavior,
    onCloseBehaviorChange,
    language,
    remoteAccessStatus,
  } = state;
  const closeBehaviorSubmenu = process.platform === 'win32'
    ? [
        { type: 'separator' as const },
        {
          label: 'Close Button Behavior',
          submenu: [
            {
              label: 'Ask every time',
              type: 'radio' as const,
              checked: closeBehavior === 'ask',
              click: () => onCloseBehaviorChange('ask'),
            },
            {
              label: 'Send to tray',
              type: 'radio' as const,
              checked: closeBehavior === 'tray',
              click: () => onCloseBehaviorChange('tray'),
            },
            {
              label: 'Quit Tessera',
              type: 'radio' as const,
              checked: closeBehavior === 'quit',
              click: () => onCloseBehaviorChange('quit'),
            },
          ],
        },
      ]
    : [];

  return Menu.buildFromTemplate([
    {
      label: 'Show Tessera',
      click: () => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
      },
    },
    {
      label: formatRemoteAccessTrayLabel(language, remoteAccessStatus),
      enabled: false,
    },
    ...closeBehaviorSubmenu,
    { type: 'separator' },
    {
      label: 'Quit',
      click: onQuit,
    },
  ]);
}

export function createTray(
  win: BrowserWindow,
  onQuit: () => void,
  options: {
    closeBehavior?: WindowsCloseBehavior;
    onCloseBehaviorChange?: (behavior: WindowsCloseBehavior) => void;
    language?: ElectronLanguage;
    remoteAccessStatus?: RemoteAccessStatus | null;
  } = {},
): void {
  const iconPath = getTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);

  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Tessera');

  trayState = {
    win,
    onQuit,
    closeBehavior: options.closeBehavior ?? 'ask',
    onCloseBehaviorChange: options.onCloseBehaviorChange ?? (() => {}),
    language: options.language ?? 'en',
    remoteAccessStatus: options.remoteAccessStatus ?? null,
  };

  tray.setContextMenu(buildContextMenu(trayState));

  // Windows/Linux: left-click toggles window
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (win.isDestroyed()) return;
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    });
  }
}

export function updateTrayCloseBehavior(behavior: WindowsCloseBehavior): void {
  if (!tray || !trayState) return;

  trayState = {
    ...trayState,
    closeBehavior: behavior,
  };

  tray.setContextMenu(buildContextMenu(trayState));
}

export function updateTrayRemoteAccessStatus(status: RemoteAccessStatus | null): void {
  if (!tray || !trayState) return;

  trayState = {
    ...trayState,
    remoteAccessStatus: status,
  };

  const label = formatRemoteAccessTrayLabel(trayState.language, status);
  tray.setToolTip(`Tessera — ${label}`);
  tray.setContextMenu(buildContextMenu(trayState));
}

export function destroyTray(): void {
  const activeTray = tray;
  tray = null;
  trayState = null;
  if (!activeTray || activeTray.isDestroyed()) return;

  try {
    activeTray.destroy();
  } catch {
    // Electron may destroy tray objects while app shutdown is already underway.
  }
}
