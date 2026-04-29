import { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { fork, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createTray } from './tray';

type TitlebarMenuSection = 'file' | 'edit' | 'view' | 'window' | 'help';
type TitlebarTheme = 'light' | 'dark';
type TitlebarThemeOptions = { dimmed?: boolean };

const WINDOWS_TITLEBAR_HEIGHT = 40;
const WINDOWS_TITLEBAR_OVERLAY_HEIGHT = WINDOWS_TITLEBAR_HEIGHT - 1;
const WINDOWS_TITLEBAR_THEME = {
  light: {
    color: '#f2f2f0',
    symbolColor: '#1a1a1a',
  },
  dark: {
    color: '#17191c',
    symbolColor: '#d7dde3',
  },
} satisfies Record<TitlebarTheme, { color: string; symbolColor: string }>;
const WINDOWS_TITLEBAR_DIMMED_THEME = {
  light: {
    color: '#5d5f60',
    symbolColor: '#f5f7f8',
  },
  dark: {
    color: '#090a0b',
    symbolColor: '#d7dde3',
  },
} satisfies Record<TitlebarTheme, { color: string; symbolColor: string }>;
const TESSERA_HOMEPAGE = 'https://github.com/Horang-Labs/tessera';

function getTitlebarOverlayOptions(theme: TitlebarTheme, options: TitlebarThemeOptions = {}) {
  const palette = options.dimmed ? WINDOWS_TITLEBAR_DIMMED_THEME[theme] : WINDOWS_TITLEBAR_THEME[theme];

  return {
    ...palette,
    height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
  };
}

function sendMenuCommand(win: BrowserWindow, command: string) {
  win.webContents.send('titlebar-menu-command', { command });
}

function buildTitlebarMenuTemplate(
  section: TitlebarMenuSection,
  win: BrowserWindow
): MenuItemConstructorOptions[] {
  switch (section) {
    case 'file':
      return [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendMenuCommand(win, 'new-tab'),
        },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuCommand(win, 'open-settings'),
        },
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' },
      ];
    case 'edit':
      return [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ];
    case 'view':
      return [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuCommand(win, 'toggle-sidebar'),
        },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ];
    case 'window':
      return [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuCommand(win, 'toggle-sidebar'),
        },
      ];
    case 'help':
      return [
        {
          label: 'Tessera on GitHub',
          click: () => {
            shell.openExternal(TESSERA_HOMEPAGE);
          },
        },
      ];
    default:
      return [];
  }
}

// ── Debug log to file (visible on Windows) ─────────────────────────────
const LOG_PATH = path.join(os.homedir(), '.tessera', 'tessera-main.log');
function log(msg: string) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
}

function attachServerProcessLogging(child: ChildProcess) {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', (chunk: string | Buffer) => {
    const text = String(chunk).trim();
    if (text) {
      log(`[server:stdout] ${text}`);
    }
  });

  child.stderr?.on('data', (chunk: string | Buffer) => {
    const text = String(chunk).trim();
    if (text) {
      log(`[server:stderr] ${text}`);
    }
  });
}

// ── Single instance lock ───────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── GPU fallback ─────────────────────────────────────────────────────────
// Electron enables GPU acceleration by default. Keep an escape hatch for
// unstable virtual/driver environments without penalizing normal Windows use.
// Must be called before app.whenReady().
if (process.env.TESSERA_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let isQuitting = false;

// ── Port allocation ────────────────────────────────────────────────────────
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Server lifecycle ───────────────────────────────────────────────────────
async function startServer(): Promise<number> {
  const devPort = process.env.TESSERA_DEV_PORT;
  if (devPort) {
    serverPort = parseInt(devPort, 10);
    return serverPort;
  }

  const port = await findFreePort();
  log(`Free port found: ${port}`);

  return new Promise((resolve, reject) => {
    const isPackaged = app.isPackaged;
    const appRoot = app.getAppPath();
    const serverCwd = isPackaged ? process.resourcesPath : appRoot;
    const serverScript = path.join(appRoot, 'dist-electron', 'electron', 'server-child.js');

    log(`isPackaged=${isPackaged}, appRoot=${appRoot}, serverCwd=${serverCwd}`);
    log(`serverScript=${serverScript}, exists=${fs.existsSync(serverScript)}`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: isPackaged ? 'production' : 'development',
      ELECTRON_CHILD: '1',
      TESSERA_APP_ROOT: appRoot,
      // Makes the Electron exe behave as plain Node.js for fork()
      ELECTRON_RUN_AS_NODE: '1',
    };
    if (process.platform === 'linux') {
      childEnv.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;
    }

    log('Forking server child...');
    serverProcess = fork(serverScript, [], {
      cwd: serverCwd,
      env: childEnv,
      silent: true,
    });
    log(`Server child forked, pid=${serverProcess.pid}`);
    attachServerProcessLogging(serverProcess);

    const timeout = setTimeout(() => {
      log('Server start timeout (60s)');
      reject(new Error('Server failed to start within 60 seconds'));
    }, 60_000);

    serverProcess.on('message', (msg: { type: string; port?: number; message?: string }) => {
      log(`Server message: ${JSON.stringify(msg)}`);
      if (msg?.type === 'ready') {
        clearTimeout(timeout);
        serverPort = msg.port as number;
        resolve(serverPort);
      } else if (msg?.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(msg.message));
      }
    });

    serverProcess.on('exit', (code) => {
      log(`Server child exited with code ${code}`);
      serverProcess = null;
      if (!isQuitting) {
        dialog.showErrorBox(
          'Tessera',
          `Server exited unexpectedly (code ${code}). The application will now close.`
        );
        isQuitting = true;
        app.quit();
      }
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function stopServer(): Promise<void> {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      resolve();
    }, 12_000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      proc.send({ type: 'shutdown' });
    } catch {
      // IPC channel already closed — process may have exited
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow(port: number): BrowserWindow {
  const isWindows = process.platform === 'win32';
  const initialTitlebarTheme: TitlebarTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Tessera',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: isWindows,
    backgroundColor: isWindows ? WINDOWS_TITLEBAR_THEME[initialTitlebarTheme].color : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows ? getTitlebarOverlayOptions(initialTitlebarTheme) : false,
  });

  if (isWindows) {
    win.removeMenu();
  }

  const url = `http://localhost:${port}`;
  win.loadURL(url);

  win.once('ready-to-show', () => {
    win.show();
  });

  // Fallback: force-show window after 15s even if page fails to load
  const showTimeout = setTimeout(() => {
    if (!win.isVisible()) {
      console.error('[Tessera] ready-to-show timeout — force-showing window');
      win.show();
      win.webContents.openDevTools();
    }
  }, 15_000);

  win.once('ready-to-show', () => clearTimeout(showTimeout));

  // Log renderer failures
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[Tessera] Page load failed: ${code} ${desc} (${url})`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Tessera] Renderer crashed:', details.reason);
  });

  // Open external links in system browser (only http/https for security)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Minimize to tray on close
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-server-port', () => serverPort);
ipcMain.handle(
  'titlebar-popup-menu',
  (event, section: TitlebarMenuSection, anchor?: { x?: number; y?: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const menu = Menu.buildFromTemplate(buildTitlebarMenuTemplate(section, win));
    menu.popup({
      window: win,
      x: typeof anchor?.x === 'number' ? anchor.x : undefined,
      y: typeof anchor?.y === 'number' ? anchor.y : undefined,
    });
  }
);
ipcMain.on('set-titlebar-theme', (event, theme: TitlebarTheme, options?: TitlebarThemeOptions) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || process.platform !== 'win32') return;

  const resolvedTheme: TitlebarTheme = theme === 'dark' ? 'dark' : 'light';
  win.setTitleBarOverlay(getTitlebarOverlayOptions(resolvedTheme, {
    dimmed: options?.dimmed === true,
  }));
});

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    const port = await startServer();
    mainWindow = createWindow(port);
    createTray(mainWindow, () => {
      isQuitting = true;
      app.quit();
    });
  } catch (err) {
    dialog.showErrorBox('Tessera', `Failed to start server: ${err}`);
    app.quit();
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', async (event) => {
  event.preventDefault();
  try {
    await stopServer();
  } finally {
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  // Do nothing — tray keeps app alive
});
