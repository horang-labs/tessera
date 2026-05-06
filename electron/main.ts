import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Menu,
  nativeTheme,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from 'electron';
import { fork, ChildProcess, spawnSync } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { createTray, destroyTray, updateTrayCloseBehavior } from './tray';
import { getTesseraDataPath } from '../src/lib/tessera-data-dir';

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
const TESSERA_HOMEPAGE = 'https://github.com/horang-labs/tessera';

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

function menuItemEnabled(value: boolean | undefined): boolean {
  return value ?? true;
}

function buildWebContentsContextMenuTemplate(
  params: ContextMenuParams
): MenuItemConstructorOptions[] {
  const { editFlags } = params;

  if (params.isEditable) {
    return [
      { role: 'undo', enabled: menuItemEnabled(editFlags.canUndo) },
      { role: 'redo', enabled: menuItemEnabled(editFlags.canRedo) },
      { type: 'separator' },
      { role: 'cut', enabled: menuItemEnabled(editFlags.canCut) },
      { role: 'copy', enabled: menuItemEnabled(editFlags.canCopy) },
      { role: 'paste', enabled: menuItemEnabled(editFlags.canPaste) },
      { role: 'delete', enabled: menuItemEnabled(editFlags.canDelete) },
      { type: 'separator' },
      { role: 'selectAll', enabled: menuItemEnabled(editFlags.canSelectAll) },
    ];
  }

  if (params.selectionText.length > 0) {
    return [
      { role: 'copy', enabled: menuItemEnabled(editFlags.canCopy) },
      { type: 'separator' },
      { role: 'selectAll', enabled: menuItemEnabled(editFlags.canSelectAll) },
    ];
  }

  if (editFlags.canSelectAll) {
    return [{ role: 'selectAll' }];
  }

  return [];
}

// ── Diagnostic log to file (visible on Windows) ─────────────────────────
const LOG_PATH = getTesseraDataPath('tessera-main.log');
type ElectronLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LOG_LEVEL_WEIGHT: Record<ElectronLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

function normalizeElectronLogLevel(value: string | undefined): ElectronLogLevel | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized in LOG_LEVEL_WEIGHT) {
    return normalized as ElectronLogLevel;
  }
  return null;
}

const ELECTRON_LOG_LEVEL =
  normalizeElectronLogLevel(process.env.TESSERA_ELECTRON_LOG_LEVEL) ??
  normalizeElectronLogLevel(process.env.LOG_LEVEL) ??
  (app.isPackaged ? 'error' : 'debug');

function log(level: ElectronLogLevel, msg: string) {
  if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[ELECTRON_LOG_LEVEL]) {
    return;
  }
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`);
}

function classifyServerStdout(line: string): ElectronLogLevel {
  try {
    const parsed = JSON.parse(line) as { level?: string | number };
    if (typeof parsed.level === 'number') {
      if (parsed.level >= 60) return 'fatal';
      if (parsed.level >= 50) return 'error';
      if (parsed.level >= 40) return 'warn';
      if (parsed.level >= 30) return 'info';
      return 'debug';
    }
    if (typeof parsed.level === 'string') {
      const level = normalizeElectronLogLevel(parsed.level);
      if (level) return level;
    }
  } catch {
    // Non-JSON stdout is usually framework readiness text; keep it behind debug logging.
  }
  return 'debug';
}

function classifyServerStderr(line: string): ElectronLogLevel {
  const parsedLevel = classifyServerStdout(line);
  if (parsedLevel !== 'debug') {
    return parsedLevel;
  }
  return /\b(error|fatal|failed|uncaught|unhandled)\b/i.test(line) ? 'error' : 'debug';
}

function logServerProcessChunk(source: 'stdout' | 'stderr', chunk: string | Buffer) {
  for (const line of String(chunk).split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const level = source === 'stderr' ? classifyServerStderr(text) : classifyServerStdout(text);
    log(level, `[server:${source}] ${text}`);
  }
}

function attachServerProcessLogging(child: ChildProcess) {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  child.stdout?.on('data', (chunk: string | Buffer) => {
    logServerProcessChunk('stdout', chunk);
  });

  child.stderr?.on('data', (chunk: string | Buffer) => {
    logServerProcessChunk('stderr', chunk);
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
let isQuitRequested = false;
let isQuitCleanupStarted = false;
let closeRequestSequence = 0;
let activeCloseRequest: Promise<void> | null = null;

type WindowCloseAction = 'quit' | 'tray' | 'cancel';
type WindowsCloseBehavior = 'ask' | 'tray' | 'quit';
type PendingCloseRequest = {
  webContentsId: number;
  resolve: (action: WindowCloseAction) => void;
};

const WINDOW_CLOSE_RESPONSE_TIMEOUT_MS = 15_000;
const SERVER_SHUTDOWN_TIMEOUT_MS = 8_000;
const pendingCloseRequests = new Map<string, PendingCloseRequest>();
let windowsCloseBehavior: WindowsCloseBehavior = 'ask';

function requestAppQuit(): void {
  if (isQuitRequested) return;

  isQuitRequested = true;
  isQuitting = true;
  activeCloseRequest = null;
  for (const [requestId, pending] of pendingCloseRequests) {
    pending.resolve('cancel');
    pendingCloseRequests.delete(requestId);
  }
  destroyTray();
  app.quit();
}

function getWindowsCloseAction(win: BrowserWindow): WindowCloseAction {
  const response = dialog.showMessageBoxSync(win, {
    type: 'question',
    title: 'Tessera',
    message: 'Close Tessera?',
    detail: 'Quit the app completely, or keep it running in the system tray?',
    buttons: ['Quit Tessera', 'Send to Tray', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  });

  if (response === 0) return 'quit';
  if (response === 1) return 'tray';
  return 'cancel';
}

function isWindowCloseAction(value: unknown): value is WindowCloseAction {
  return value === 'quit' || value === 'tray' || value === 'cancel';
}

function isWindowsCloseBehavior(value: unknown): value is WindowsCloseBehavior {
  return value === 'ask' || value === 'tray' || value === 'quit';
}

function sendRendererCommand(command: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('titlebar-menu-command', { command });
}

function setWindowsCloseBehavior(behavior: WindowsCloseBehavior): void {
  windowsCloseBehavior = behavior;
  updateTrayCloseBehavior(behavior);
}

function handleTrayCloseBehaviorChange(behavior: WindowsCloseBehavior): void {
  setWindowsCloseBehavior(behavior);
  sendRendererCommand(`set-windows-close-behavior:${behavior}`);
}

function requestRendererCloseAction(win: BrowserWindow): Promise<WindowCloseAction> {
  const requestId = `close-${Date.now()}-${++closeRequestSequence}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingCloseRequests.delete(requestId);
      resolve(isQuitting || win.isDestroyed() ? 'cancel' : getWindowsCloseAction(win));
    }, WINDOW_CLOSE_RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    if (win.isDestroyed()) {
      clearTimeout(timeout);
      resolve('cancel');
      return;
    }

    pendingCloseRequests.set(requestId, {
      webContentsId: win.webContents.id,
      resolve: (action) => {
        clearTimeout(timeout);
        pendingCloseRequests.delete(requestId);
        resolve(action);
      },
    });

    win.webContents.send('window-close-requested', { requestId });
  });
}

function applyWindowCloseAction(win: BrowserWindow, action: WindowCloseAction): void {
  if (isQuitting) return;
  if (win.isDestroyed()) return;

  if (action === 'quit') {
    requestAppQuit();
  } else if (action === 'tray') {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function forceKillProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        timeout: 5_000,
        windowsHide: true,
      });
    } catch {
      // Process may have already exited.
    }
    return;
  }

  try {
    proc.kill('SIGKILL');
  } catch {
    // Process may have already exited.
  }
}

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
  log('debug', `Free port found: ${port}`);

  return new Promise((resolve, reject) => {
    const isPackaged = app.isPackaged;
    const appRoot = app.getAppPath();
    const serverCwd = isPackaged ? process.resourcesPath : appRoot;
    const serverScript = path.join(appRoot, 'dist-electron', 'electron', 'server-child.js');

    log('debug', `isPackaged=${isPackaged}, appRoot=${appRoot}, serverCwd=${serverCwd}`);
    log('debug', `serverScript=${serverScript}, exists=${fs.existsSync(serverScript)}`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: isPackaged ? 'production' : 'development',
      ELECTRON_CHILD: '1',
      TESSERA_ELECTRON_SERVER: '1',
      TESSERA_PRODUCTION_DB: '1',
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
      TESSERA_APP_ROOT: appRoot,
      TESSERA_CHANNEL: process.env.TESSERA_CHANNEL || (isPackaged ? 'github-release' : 'dev'),
      // Makes the Electron exe behave as plain Node.js for fork()
      ELECTRON_RUN_AS_NODE: '1',
    };
    if (process.platform === 'linux') {
      childEnv.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;
    }

    log('debug', 'Forking server child...');
    serverProcess = fork(serverScript, [], {
      cwd: serverCwd,
      env: childEnv,
      silent: true,
    });
    log('debug', `Server child forked, pid=${serverProcess.pid}`);
    attachServerProcessLogging(serverProcess);

    const timeout = setTimeout(() => {
      log('error', 'Server start timeout (60s)');
      reject(new Error('Server failed to start within 60 seconds'));
    }, 60_000);

    serverProcess.on('message', (msg: { type: string; port?: number; message?: string }) => {
      log('debug', `Server message: ${JSON.stringify(msg)}`);
      if (msg?.type === 'ready') {
        clearTimeout(timeout);
        serverPort = msg.port as number;
        resolve(serverPort);
      } else if (msg?.type === 'error') {
        clearTimeout(timeout);
        log('error', `Server child reported error: ${msg.message ?? 'unknown error'}`);
        reject(new Error(msg.message));
      }
    });

    serverProcess.on('exit', (code) => {
      log(isQuitting ? 'debug' : 'error', `Server child exited with code ${code}`);
      serverProcess = null;
      if (!isQuitting) {
        dialog.showErrorBox(
          'Tessera',
          `Server exited unexpectedly (code ${code}). The application will now close.`
        );
        requestAppQuit();
      }
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      log('error', `Server child process error: ${err.message}`);
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
      log('warn', `Server shutdown timeout (${SERVER_SHUTDOWN_TIMEOUT_MS}ms), forcing process tree kill`);
      forceKillProcessTree(proc);
      resolve();
    }, SERVER_SHUTDOWN_TIMEOUT_MS);

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
  const isMac = process.platform === 'darwin';
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
    autoHideMenuBar: !isMac,
    backgroundColor: isWindows ? WINDOWS_TITLEBAR_THEME[initialTitlebarTheme].color : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows ? getTitlebarOverlayOptions(initialTitlebarTheme) : false,
  });

  if (!isMac) {
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
      log('error', 'ready-to-show timeout; force-showing window');
      console.error('[Tessera] ready-to-show timeout — force-showing window');
      win.show();
      win.webContents.openDevTools();
    }
  }, 15_000);

  win.once('ready-to-show', () => clearTimeout(showTimeout));

  // Log renderer failures
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('error', `Page load failed: ${code} ${desc} (${url})`);
    console.error(`[Tessera] Page load failed: ${code} ${desc} (${url})`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log('error', `Renderer crashed: ${details.reason}`);
    console.error('[Tessera] Renderer crashed:', details.reason);
  });

  // Open external links in system browser (only http/https for security)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('context-menu', (_event, params) => {
    const template = buildWebContentsContextMenuTemplate(params);
    if (template.length === 0) return;

    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win,
      x: params.x,
      y: params.y,
    });
  });

  // Windows asks in the renderer so the prompt matches the Tessera UI and can
  // remember the chosen behavior. Other platforms preserve tray behavior.
  win.on('close', (event) => {
    if (isQuitting) return;

    event.preventDefault();

    if (process.platform !== 'win32') {
      win.hide();
      return;
    }

    if (activeCloseRequest) {
      if (isQuitting) return;
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      return;
    }

    activeCloseRequest = (async () => {
      try {
        const action = await requestRendererCloseAction(win);
        applyWindowCloseAction(win, action);
      } finally {
        activeCloseRequest = null;
      }
    })();
  });

  return win;
}

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-server-port', () => serverPort);
ipcMain.on(
  'window-close-response',
  (
    event,
    payload?: {
      requestId?: unknown;
      action?: unknown;
    },
  ) => {
    if (typeof payload?.requestId !== 'string') return;
    if (!isWindowCloseAction(payload.action)) return;

    const pending = pendingCloseRequests.get(payload.requestId);
    if (!pending || pending.webContentsId !== event.sender.id) return;

    pending.resolve(payload.action);
  },
);
ipcMain.on('windows-close-behavior-changed', (_event, behavior: unknown) => {
  if (!isWindowsCloseBehavior(behavior)) return;
  setWindowsCloseBehavior(behavior);
});
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
    createTray(mainWindow, requestAppQuit, {
      closeBehavior: windowsCloseBehavior,
      onCloseBehaviorChange: handleTrayCloseBehaviorChange,
    });
  } catch (err) {
    dialog.showErrorBox('Tessera', `Failed to start server: ${err}`);
    requestAppQuit();
  }
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitRequested = true;
  isQuitting = true;
  destroyTray();
});

app.on('will-quit', async (event) => {
  if (isQuitCleanupStarted) return;

  isQuitCleanupStarted = true;
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
