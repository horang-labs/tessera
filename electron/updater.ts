import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { DesktopUpdateEvent, DesktopUpdateInfo, DesktopUpdateResult } from '../src/types/electron-updater';

type ElectronLogger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
type PrepareForUpdateInstall = () => void;

let mainWindow: BrowserWindow | null = null;
let initialized = false;
let latestInfo: DesktopUpdateInfo | null = null;
let downloadedInfo: DesktopUpdateInfo | null = null;
let lastError: string | null = null;

function toDesktopUpdateInfo(info: UpdateInfo | null | undefined): DesktopUpdateInfo {
  return {
    version: info?.version ?? null,
    releaseDate: info?.releaseDate ?? null,
    releaseName: info?.releaseName ?? null,
    releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
  };
}

function toProgress(progress: ProgressInfo) {
  return {
    percent: Number.isFinite(progress.percent) ? progress.percent : 0,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  };
}

function currentResult(status: DesktopUpdateResult['status']): DesktopUpdateResult {
  const info = downloadedInfo ?? latestInfo;
  return {
    status,
    currentVersion: app.getVersion(),
    updateAvailable: status === 'available' || status === 'downloaded',
    latestVersion: info?.version ?? null,
    error: lastError,
  };
}

function unsupportedResult(): DesktopUpdateResult {
  return {
    status: 'unsupported',
    currentVersion: app.getVersion(),
    updateAvailable: false,
    latestVersion: null,
    error: getUnsupportedReason(),
  };
}

function getUnsupportedReason(): string | null {
  if (!app.isPackaged) return 'Desktop auto-update is only available in packaged builds.';
  if (process.platform !== 'darwin') {
    return 'Desktop auto-update is currently available for macOS packaged builds only.';
  }
  return null;
}

function isDesktopAutoUpdateSupported(): boolean {
  return app.isPackaged && process.platform === 'darwin';
}

function sendUpdateEvent(event: DesktopUpdateEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop-update-event', event);
}

export function setupDesktopUpdater(
  win: BrowserWindow,
  log: ElectronLogger,
  prepareForUpdateInstall: PrepareForUpdateInstall = () => {},
): void {
  mainWindow = win;
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    lastError = null;
    sendUpdateEvent({ type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    latestInfo = toDesktopUpdateInfo(info);
    lastError = null;
    sendUpdateEvent({ type: 'available', info: latestInfo });
  });

  autoUpdater.on('update-not-available', (info) => {
    latestInfo = toDesktopUpdateInfo(info);
    lastError = null;
    sendUpdateEvent({ type: 'not-available', info: latestInfo });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent({ type: 'progress', progress: toProgress(progress) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedInfo = toDesktopUpdateInfo(info);
    latestInfo = downloadedInfo;
    lastError = null;
    sendUpdateEvent({ type: 'downloaded', info: downloadedInfo });
  });

  autoUpdater.on('error', (error) => {
    lastError = error.message;
    log('error', `Desktop updater error: ${error.message}`);
    sendUpdateEvent({ type: 'error', error: error.message });
  });

  ipcMain.handle('desktop-update-check', async () => {
    if (!isDesktopAutoUpdateSupported()) return unsupportedResult();

    try {
      const result = await autoUpdater.checkForUpdates();
      const info = toDesktopUpdateInfo(result?.updateInfo);
      latestInfo = info;
      const updateAvailable = result?.isUpdateAvailable === true;
      return {
        status: updateAvailable ? 'available' : 'current',
        currentVersion: app.getVersion(),
        updateAvailable,
        latestVersion: info.version,
        error: null,
      } satisfies DesktopUpdateResult;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Desktop update check failed';
      return currentResult('error');
    }
  });

  ipcMain.handle('desktop-update-download', async () => {
    if (!isDesktopAutoUpdateSupported()) return unsupportedResult();

    try {
      await autoUpdater.downloadUpdate();
      return currentResult('downloaded');
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Desktop update download failed';
      return currentResult('error');
    }
  });

  ipcMain.handle('desktop-update-install', () => {
    if (!isDesktopAutoUpdateSupported()) return;
    prepareForUpdateInstall();
    autoUpdater.quitAndInstall(false, true);
  });
}
