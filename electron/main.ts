import {
  app,
  BrowserWindow,
  clipboard,
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
import { normalizeExternalHttpUrl } from '../src/lib/external-http-url';
import { readTerminalClipboard, writeTerminalClipboardText } from './terminal-clipboard';

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
const MAX_SHELL_PATH_LENGTH = 32768;
const ELECTRON_DEFAULT_PORT = 32123;
const ELECTRON_PORT_SCAN_LIMIT = 100;
const UI_STORAGE_PATH = getTesseraDataPath('ui-state.json');

function readUiStorage(): Record<string, string> {
  try {
    const raw = fs.readFileSync(UI_STORAGE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const state: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof value === 'string') {
        state[key] = value;
      }
    }
    return state;
  } catch {
    return {};
  }
}

function writeUiStorage(state: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(UI_STORAGE_PATH), { recursive: true });
    const tmpPath = `${UI_STORAGE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
    fs.renameSync(tmpPath, UI_STORAGE_PATH);
  } catch (error) {
    log('warn', `Failed to write UI storage: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getUiStorageItem(key: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  return readUiStorage()[key] ?? null;
}

function setUiStorageItem(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const { key, value } = payload as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || key.length === 0 || typeof value !== 'string') return;
  const state = readUiStorage();
  state[key] = value;
  writeUiStorage(state);
}

function removeUiStorageItem(key: unknown): void {
  if (typeof key !== 'string' || key.length === 0) return;
  const state = readUiStorage();
  if (!(key in state)) return;
  delete state[key];
  writeUiStorage(state);
}

function isWindowsStylePath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith('\\\\')
    || filesystemPath.startsWith('//')
  );
}

function getShellPathModule(filesystemPath: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(filesystemPath) || process.platform === 'win32'
    ? path.win32
    : path.posix;
}

function convertWslPathWithWslpath(filesystemPath: string): string | null {
  try {
    const result = spawnSync('wsl.exe', ['-e', 'wslpath', '-w', filesystemPath], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    const converted = result.stdout?.trim();
    return result.status === 0 && converted ? converted : null;
  } catch {
    return null;
  }
}

function convertPosixPathForWindowsShell(filesystemPath: string): string {
  if (filesystemPath.startsWith('//')) return filesystemPath.replace(/\//g, '\\');
  if (process.platform !== 'win32' || !filesystemPath.startsWith('/')) return filesystemPath;

  const converted = convertWslPathWithWslpath(filesystemPath);
  if (converted) return converted;

  const mountedDriveMatch = filesystemPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (mountedDriveMatch) {
    const drive = mountedDriveMatch[1].toUpperCase();
    const rest = mountedDriveMatch[2]?.replace(/\//g, '\\') ?? '';
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  const distro = process.env.WSL_DISTRO_NAME;
  if (distro) {
    return `\\\\wsl.localhost\\${distro}${filesystemPath.replace(/\//g, '\\')}`;
  }

  return filesystemPath;
}

function resolveShellPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > MAX_SHELL_PATH_LENGTH || trimmed.includes('\0')) {
    return null;
  }
  return convertPosixPathForWindowsShell(trimmed);
}

function getExistingParentDirectory(filesystemPath: string): string | null {
  const pathModule = getShellPathModule(filesystemPath);
  const parent = pathModule.dirname(filesystemPath);
  if (!parent || parent === filesystemPath) return null;
  return fs.existsSync(parent) ? parent : null;
}

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

type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

function isWindowControlAction(action: unknown): action is WindowControlAction {
  return action === 'minimize' || action === 'toggle-maximize' || action === 'close';
}

function getWindowStatePayload(win: BrowserWindow) {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  };
}

function sendWindowState(win: BrowserWindow) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('window-state-changed', getWindowStatePayload(win));
}

function bindWindowStateEvents(win: BrowserWindow) {
  win.on('maximize', () => sendWindowState(win));
  win.on('unmaximize', () => sendWindowState(win));
  win.on('enter-full-screen', () => sendWindowState(win));
  win.on('leave-full-screen', () => sendWindowState(win));
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
} else {
  // Blink force-loses the oldest WebGL context past 16 per renderer, and every
  // attached terminal surface holds one. Inactive tabs stay mounted (LRU) and
  // parked surfaces keep their terminal alive, so a busy workspace exceeds 16
  // and evicted surfaces are silently downgraded to the DOM renderer mid-session.
  // 128 covers real layouts while keeping a bound so context leaks still surface.
  app.commandLine.appendSwitch('max-active-webgl-contexts', '128');
}

let mainWindow: BrowserWindow | null = null;
const popoutWindows = new Set<BrowserWindow>();
let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let isQuitting = false;
let isQuitRequested = false;
let isQuitCleanupStarted = false;
let closeRequestSequence = 0;
let activeCloseRequest: Promise<void> | null = null;
let activeQuitConfirmation: Promise<void> | null = null;
let terminalSummarySequence = 0;

type WindowCloseAction = 'quit' | 'tray' | 'cancel';
type WindowsCloseBehavior = 'ask' | 'tray' | 'quit';
type PendingCloseRequest = {
  webContentsId: number;
  resolve: (action: WindowCloseAction) => void;
};

const WINDOW_CLOSE_RESPONSE_TIMEOUT_MS = 15_000;
const SERVER_SHUTDOWN_TIMEOUT_MS = 8_000;
const TERMINAL_SUMMARY_TIMEOUT_MS = 1_500;
const pendingCloseRequests = new Map<string, PendingCloseRequest>();
type TerminalRuntimeSummary = { activeCount: number; sessionCount: number };
type PendingTerminalSummary = {
  resolve: (summary: TerminalRuntimeSummary) => void;
  timeout: NodeJS.Timeout;
};
const pendingTerminalSummaries = new Map<string, PendingTerminalSummary>();
let windowsCloseBehavior: WindowsCloseBehavior = 'ask';

function resolveTerminalSummary(
  requestId: string,
  summary: TerminalRuntimeSummary,
): void {
  const pending = pendingTerminalSummaries.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingTerminalSummaries.delete(requestId);
  pending.resolve(summary);
}

function resolveAllTerminalSummaries(): void {
  for (const requestId of [...pendingTerminalSummaries.keys()]) {
    resolveTerminalSummary(requestId, { activeCount: -1, sessionCount: -1 });
  }
}

function requestTerminalSummary(): Promise<TerminalRuntimeSummary> {
  const child = serverProcess;
  if (!child?.connected) {
    return Promise.resolve({ activeCount: 0, sessionCount: 0 });
  }

  const requestId = `terminal-summary-${Date.now()}-${++terminalSummarySequence}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingTerminalSummaries.delete(requestId);
      log('warn', 'Timed out while checking active terminals before quit');
      resolve({ activeCount: -1, sessionCount: -1 });
    }, TERMINAL_SUMMARY_TIMEOUT_MS);
    timeout.unref?.();
    pendingTerminalSummaries.set(requestId, { resolve, timeout });

    try {
      child.send({ type: 'terminal_summary_request', requestId }, (error) => {
        if (!error) return;
        log('warn', `Terminal summary IPC failed: ${error.message}`);
        resolveTerminalSummary(requestId, { activeCount: -1, sessionCount: -1 });
      });
    } catch (error) {
      log('warn', `Terminal summary IPC threw: ${error instanceof Error ? error.message : String(error)}`);
      resolveTerminalSummary(requestId, { activeCount: -1, sessionCount: -1 });
    }
  });
}

async function confirmTerminalQuit(activeCount: number): Promise<boolean> {
  if (activeCount === 0) return true;

  const isKorean = app.getLocale().toLowerCase().startsWith('ko');
  const summaryUnavailable = activeCount < 0;
  const options = {
    type: 'warning' as const,
    title: 'Tessera',
    message: isKorean
      ? (summaryUnavailable
          ? '터미널 상태를 확인하지 못했습니다. Tessera를 종료할까요?'
          : `실행 중인 터미널 ${activeCount}개를 종료할까요?`)
      : (summaryUnavailable
          ? 'Terminal status is unavailable. Quit Tessera?'
          : `Quit ${activeCount} active terminal${activeCount === 1 ? '' : 's'}?`),
    detail: isKorean
      ? (summaryUnavailable
          ? '종료하면 실행 중인 터미널 작업이 함께 중단될 수 있습니다.'
          : 'Tessera를 종료하면 터미널에서 실행 중인 Claude Code/Codex 작업도 함께 종료됩니다.')
      : (summaryUnavailable
          ? 'Quitting may stop active terminal work.'
          : 'Quitting Tessera will also stop the Claude Code/Codex work running in these terminals.'),
    buttons: isKorean ? ['취소', 'Tessera 종료'] : ['Cancel', 'Quit Tessera'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function beginAppQuit(): Promise<void> {
  if (isQuitRequested) return;

  const summary = await requestTerminalSummary();
  if (!(await confirmTerminalQuit(summary.activeCount))) return;

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

function requestAppQuit(): void {
  if (isQuitRequested || activeQuitConfirmation) return;
  activeQuitConfirmation = beginAppQuit().finally(() => {
    activeQuitConfirmation = null;
  });
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
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findStablePort(): Promise<number> {
  for (let offset = 0; offset < ELECTRON_PORT_SCAN_LIMIT; offset += 1) {
    const candidate = ELECTRON_DEFAULT_PORT + offset;
    if (await isPortAvailable(candidate)) return candidate;
  }
  throw new Error(
    `No available port found from ${ELECTRON_DEFAULT_PORT} to ${ELECTRON_DEFAULT_PORT + ELECTRON_PORT_SCAN_LIMIT - 1}`
  );
}

// ── Server lifecycle ───────────────────────────────────────────────────────
async function startServer(): Promise<number> {
  const devPort = process.env.TESSERA_DEV_PORT;
  if (devPort) {
    serverPort = parseInt(devPort, 10);
    return serverPort;
  }

  const port = await findStablePort();
  log('debug', `Electron server port selected: ${port}`);

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

    serverProcess.on('message', (msg: {
      type: string;
      port?: number;
      message?: string;
      requestId?: string;
      activeCount?: number;
      sessionCount?: number;
    }) => {
      log('debug', `Server message: ${JSON.stringify(msg)}`);
      if (
        msg?.type === 'terminal_summary'
        && typeof msg.requestId === 'string'
        && typeof msg.activeCount === 'number'
        && typeof msg.sessionCount === 'number'
      ) {
        resolveTerminalSummary(msg.requestId, {
          activeCount: msg.activeCount,
          sessionCount: msg.sessionCount,
        });
      } else if (msg?.type === 'ready') {
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
      resolveAllTerminalSummaries();
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

    const requestSignalShutdown = (reason: string) => {
      log('warn', `${reason}; sending SIGTERM to server child`);
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have already exited.
      }
    };

    try {
      if (proc.connected) {
        proc.send({ type: 'shutdown' }, (error) => {
          if (error) {
            requestSignalShutdown(`Server shutdown IPC failed: ${error.message}`);
          }
        });
      } else {
        requestSignalShutdown('Server shutdown IPC channel already closed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      requestSignalShutdown(`Server shutdown IPC threw: ${message}`);
    }
  });
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow(port: number): BrowserWindow {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const initialTitlebarTheme: TitlebarTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Tessera',
    show: false,
    frame: !isLinux,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: !isMac,
    backgroundColor: isWindows || isLinux ? WINDOWS_TITLEBAR_THEME[initialTitlebarTheme].color : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows ? getTitlebarOverlayOptions(initialTitlebarTheme) : false,
  });

  bindWindowStateEvents(win);

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

// ── Popout window ──────────────────────────────────────────────────────────
function createPopoutWindow(port: number, route: string): BrowserWindow {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const initialTitlebarTheme: TitlebarTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Tessera Board',
    show: false,
    frame: !isLinux,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: !isMac,
    backgroundColor: isWindows || isLinux ? WINDOWS_TITLEBAR_THEME[initialTitlebarTheme].color : undefined,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows ? getTitlebarOverlayOptions(initialTitlebarTheme) : false,
  });

  bindWindowStateEvents(win);

  if (!isMac) {
    win.removeMenu();
  }

  const url = `http://localhost:${port}${route}`;
  win.loadURL(url);

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith('https://') || openUrl.startsWith('http://')) {
      shell.openExternal(openUrl);
    }
    return { action: 'deny' };
  });

  win.webContents.on('context-menu', (_event, params) => {
    const template = buildWebContentsContextMenuTemplate(params);
    if (template.length === 0) return;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win, x: params.x, y: params.y });
  });

  popoutWindows.add(win);
  broadcastPopoutState();
  win.on('closed', () => {
    popoutWindows.delete(win);
    broadcastPopoutState();
  });

  return win;
}

function broadcastPopoutState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('popout-state-changed', { count: popoutWindows.size });
}

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-server-port', () => serverPort);
ipcMain.handle('read-terminal-clipboard', () => readTerminalClipboard(clipboard));
ipcMain.handle('write-terminal-clipboard-text', (_event, text: unknown) => (
  writeTerminalClipboardText(clipboard, text)
));
ipcMain.on('ui-storage-get-item', (event, key: unknown) => {
  event.returnValue = getUiStorageItem(key);
});
ipcMain.on('ui-storage-set-item', (event, payload: unknown) => {
  setUiStorageItem(payload);
  event.returnValue = true;
});
ipcMain.on('ui-storage-remove-item', (event, key: unknown) => {
  removeUiStorageItem(key);
  event.returnValue = true;
});
ipcMain.handle('shell-open-external-url', async (_event, rawUrl: unknown) => {
  const targetUrl = normalizeExternalHttpUrl(rawUrl);
  if (!targetUrl) return { ok: false, error: 'invalid_url' };

  try {
    await shell.openExternal(targetUrl);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
ipcMain.handle('shell-open-path', async (_event, rawPath: unknown) => {
  const targetPath = resolveShellPath(rawPath);
  if (!targetPath) return { ok: false, error: 'invalid_path' };

  const error = await shell.openPath(targetPath);
  return error ? { ok: false, error } : { ok: true };
});
ipcMain.handle('shell-show-item-in-folder', async (_event, rawPath: unknown) => {
  const targetPath = resolveShellPath(rawPath);
  if (!targetPath) return { ok: false, error: 'invalid_path' };

  if (fs.existsSync(targetPath)) {
    shell.showItemInFolder(targetPath);
    return { ok: true };
  }

  const parentDirectory = getExistingParentDirectory(targetPath);
  if (parentDirectory) {
    const error = await shell.openPath(parentDirectory);
    return error ? { ok: false, error } : { ok: true };
  }

  shell.showItemInFolder(targetPath);
  return { ok: true };
});
ipcMain.handle('open-board-window', (_event, payload?: unknown) => {
  if (!serverPort) return { ok: false };
  const params = new URLSearchParams();
  if (payload && typeof payload === 'object') {
    const { projectDir, collectionFilter } = payload as {
      projectDir?: unknown;
      collectionFilter?: unknown;
    };
    if (typeof projectDir === 'string' && projectDir.length > 0) {
      params.set('projectDir', projectDir);
    }
    if (typeof collectionFilter === 'string' && collectionFilter.length > 0) {
      params.set('collectionFilter', collectionFilter);
    }
  }
  const query = params.toString();
  const route = query ? `/board-popout?${query}` : '/board-popout';
  const win = createPopoutWindow(serverPort, route);
  return { ok: true, windowId: win.id };
});
ipcMain.handle('close-board-popouts', () => {
  for (const win of Array.from(popoutWindows)) {
    if (!win.isDestroyed()) win.close();
  }
  return { ok: true };
});
ipcMain.handle('get-popout-state', () => ({ count: popoutWindows.size }));
ipcMain.on('popout-open-session', (_event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const { sessionId, action } = payload as { sessionId?: unknown; action?: unknown };
  if (typeof sessionId !== 'string' || !sessionId) return;
  const resolvedAction: 'preview' | 'pin' = action === 'pin' ? 'pin' : 'preview';
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('popout-open-session', {
    sessionId,
    action: resolvedAction,
  });
});

// Active session / selected project sync between main and popouts.
// Sent by any window when its local UI state changes; the main process
// re-broadcasts to every OTHER window so the popout's kanban can highlight
// the active card and selected project stays mirrored.
ipcMain.on('ui-active-session-changed', (event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const { sessionId } = payload as { sessionId?: unknown };
  if (sessionId !== null && typeof sessionId !== 'string') return;
  const senderId = event.sender.id;
  const targets: BrowserWindow[] = [];
  if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow);
  for (const win of popoutWindows) targets.push(win);
  for (const win of targets) {
    if (win.isDestroyed()) continue;
    if (win.webContents.id === senderId) continue;
    win.webContents.send('ui-active-session-changed', { sessionId });
  }
});
ipcMain.on('ui-selected-project-changed', (event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const { projectDir } = payload as { projectDir?: unknown };
  if (projectDir !== null && typeof projectDir !== 'string') return;
  const senderId = event.sender.id;
  const targets: BrowserWindow[] = [];
  if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow);
  for (const win of popoutWindows) targets.push(win);
  for (const win of targets) {
    if (win.isDestroyed()) continue;
    if (win.webContents.id === senderId) continue;
    win.webContents.send('ui-selected-project-changed', { projectDir });
  }
});
ipcMain.on('ui-collection-filter-changed', (event, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return;
  const { collectionId } = payload as { collectionId?: unknown };
  if (collectionId !== null && typeof collectionId !== 'string') return;
  const senderId = event.sender.id;
  const targets: BrowserWindow[] = [];
  if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow);
  for (const win of popoutWindows) targets.push(win);
  for (const win of targets) {
    if (win.isDestroyed()) continue;
    if (win.webContents.id === senderId) continue;
    win.webContents.send('ui-collection-filter-changed', { collectionId });
  }
});
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
ipcMain.handle('window-control', (event, action: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !isWindowControlAction(action)) return;

  if (action === 'minimize') {
    win.minimize();
  } else if (action === 'toggle-maximize') {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    sendWindowState(win);
  } else {
    win.close();
  }
});
ipcMain.handle('get-window-state', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? getWindowStatePayload(win) : { isMaximized: false, isFullScreen: false };
});
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

app.on('before-quit', (event) => {
  if (!isQuitRequested) {
    event.preventDefault();
    requestAppQuit();
    return;
  }
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
