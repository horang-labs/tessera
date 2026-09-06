/**
 * Electron server child process.
 * Mirrors server.ts with IPC signaling for Electron main process coordination.
 * This file runs in a forked child process — NOT in the Electron main process.
 */
import '../runtime/register-runtime-aliases';
import next from 'next';
import { createServer, type Server } from 'http';
import { networkInterfaces } from 'node:os';
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8';
import { initDatabase } from '../src/lib/db/database';
import { bootstrapCanonicalWorktreeRegistry } from '../src/lib/db/worktree-bootstrap';
import '../src/lib/cli/providers/bootstrap';
import { ensureRSAKeys } from '../src/lib/auth/keys';
import { ensureAppSecret } from '../src/lib/auth/app-secret';
import { wsServer } from '../src/lib/ws/server';
import { processManager } from '../src/lib/cli/process-manager';
import { getAgentEnvironment } from '../src/lib/cli/spawn-cli';
import { resolveServerDefaultUserId } from '../src/lib/server-default-user';
import { rateLimitPoller } from '../src/lib/rate-limit/poller';
import { taskPrPoller } from '../src/lib/github/task-pr-poller';
import { installTaskPrStatusBroadcast, uninstallTaskPrStatusBroadcast } from '../src/lib/github/task-pr-broadcast';
import { installSessionPrStatusBroadcast, uninstallSessionPrStatusBroadcast } from '../src/lib/github/session-pr-broadcast';
import { prewarmCliStatusSnapshot } from '../src/lib/cli/provider-status-prewarm';
import { snapshotTelemetryStartupDataState } from '../src/lib/telemetry/server-state';
import { setModelConfigBroadcast, triggerModelConfigRefresh } from '../src/lib/model-config/refresh';
import { ensureRemoteModelConfigLoaded } from '../src/lib/model-config/remote-config';
import logger from '../src/lib/logger';
import { getTesseraDataPath } from '../src/lib/tessera-data-dir';
import { terminalManager } from '../src/lib/terminal/shared-terminal-manager';
import { handleHookRequest } from '../src/lib/cli/hook-receiver';
import { CONTROL_ROUTE_PREFIX } from '../src/lib/control/http-handler';
import { readAppVersion } from '../src/lib/app-version';
import {
  startControlRuntimeHost,
  type ControlRuntimeHost,
} from '../src/lib/control/runtime-host';
import { attachRemoteAddressHeader } from '../src/lib/http/remote-address-header';
import { directListeners } from '../src/lib/http/direct-listeners';
import { loadMachineSettings } from '../src/lib/settings/machine-settings';
import { SettingsManager } from '../src/lib/settings/manager';
import { registerCurrentProjectAtStartup } from '../src/lib/projects/current-project-registration';
import { createPairingPresentation } from '../src/lib/auth/pairing-presentation';
import {
  LOOPBACK_SERVER_HOST,
  resolveDirectListenerTarget,
} from './server-listener';

process.env.ELECTRON_CHILD = '1';
process.env.TESSERA_ELECTRON_SERVER = '1';
process.env.TESSERA_PRODUCTION_DB = '1';
snapshotTelemetryStartupDataState();

const dev = process.env.NODE_ENV !== 'production';
// The listener the app itself talks to. A remote-access address never widens
// this one; it gets its own listener through directListeners, so the port is
// never opened on adapters the user did not advertise.
const hostname = LOOPBACK_SERVER_HOST;
const isPackaged = process.env.TESSERA_ELECTRON_PACKAGED === '1';
const port = parseInt(process.env.PORT || '3000', 10);
const isElectronChild = process.env.ELECTRON_CHILD === '1';
const originalParentPid = process.ppid;
// In packaged apps, cwd must be a real directory while Next should still resolve
// assets from the packaged app root (typically resources/app.asar).
const dir = process.env.TESSERA_APP_ROOT || process.cwd();

import * as fs from 'fs';
import * as path from 'path';
const STARTUP_LOG = getTesseraDataPath('startup.log');
type StartupLogLevel = 'debug' | 'error' | 'fatal';
const STARTUP_LOG_LEVEL_WEIGHT: Record<StartupLogLevel, number> = {
  debug: 10,
  error: 40,
  fatal: 50,
};

function normalizeStartupLogLevel(value: string | undefined): StartupLogLevel | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'fatal') return 'fatal';
  if (normalized === 'error') return 'error';
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn') return 'debug';
  return null;
}

const STARTUP_LOG_LEVEL =
  normalizeStartupLogLevel(process.env.TESSERA_ELECTRON_LOG_LEVEL) ??
  normalizeStartupLogLevel(process.env.LOG_LEVEL) ??
  (process.env.NODE_ENV === 'production' ? 'error' : 'debug');

function logStartup(level: StartupLogLevel, msg: string) {
  if (STARTUP_LOG_LEVEL_WEIGHT[level] < STARTUP_LOG_LEVEL_WEIGHT[STARTUP_LOG_LEVEL]) {
    return;
  }
  fs.mkdirSync(path.dirname(STARTUP_LOG), { recursive: true });
  fs.appendFileSync(STARTUP_LOG, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`);
}

let shutdownHandler: ((reason: string) => Promise<void>) | null = null;
let parentWatchdog: NodeJS.Timeout | null = null;
let oomDiagnosticsTimer: NodeJS.Timeout | null = null;
let parentShutdownRequested = false;
let controlRuntime: ControlRuntimeHost | null = null;

const OOM_DIAGNOSTICS_TAG = '[DEBUG-oom-memory-v1]';
const OOM_DIAGNOSTICS_INTERVAL_MS = 1_000;

function bytesToMiB(value: number): number {
  return Math.round((value / (1024 * 1024)) * 10) / 10;
}

function logOomDiagnostics(): void {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  const oldSpaceUsed = getHeapSpaceStatistics()
    .filter((space) => space.space_name === 'old_space' || space.space_name === 'old_large_object_space')
    .reduce((total, space) => total + space.space_used_size, 0);
  const terminal = terminalManager.collectOomDiagnostics();
  const websocket = wsServer.collectOomDiagnostics();
  const heapPressure = heap.heap_size_limit > 0 ? memory.heapUsed / heap.heap_size_limit : 0;
  const elevated = heapPressure >= 0.7
    || terminal.headlessPendingChars >= 64 * 1024 * 1024
    || terminal.pendingFrameChars >= 64 * 1024 * 1024
    || websocket.totalBufferedBytes >= 64 * 1024 * 1024;
  const fields = {
    diagnosticTag: OOM_DIAGNOSTICS_TAG,
    memoryMiB: {
      rss: bytesToMiB(memory.rss),
      heapUsed: bytesToMiB(memory.heapUsed),
      heapTotal: bytesToMiB(memory.heapTotal),
      heapLimit: bytesToMiB(heap.heap_size_limit),
      oldSpaceUsed: bytesToMiB(oldSpaceUsed),
      external: bytesToMiB(memory.external),
      arrayBuffers: bytesToMiB(memory.arrayBuffers),
    },
    heapPressure: Math.round(heapPressure * 10_000) / 10_000,
    terminal,
    websocket,
  };
  if (elevated) logger.warn(fields, `${OOM_DIAGNOSTICS_TAG} Server memory pressure sample`);
  else logger.debug(fields, `${OOM_DIAGNOSTICS_TAG} Server memory sample`);
}

function startOomDiagnostics(): void {
  if (STARTUP_LOG_LEVEL !== 'debug' || oomDiagnosticsTimer) return;
  logOomDiagnostics();
  oomDiagnosticsTimer = setInterval(logOomDiagnostics, OOM_DIAGNOSTICS_INTERVAL_MS);
  oomDiagnosticsTimer.unref?.();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function requestParentGoneShutdown(reason: string): void {
  if (parentShutdownRequested) return;
  parentShutdownRequested = true;
  logStartup('error', `Electron parent unavailable; shutting down server child (${reason})`);

  if (shutdownHandler) {
    void shutdownHandler(reason);
    return;
  }

  process.exit(1);
}

if (isElectronChild) {
  process.on('disconnect', () => {
    requestParentGoneShutdown('ipc-disconnect');
  });

  parentWatchdog = setInterval(() => {
    const parentMissing = originalParentPid > 1 && !isProcessAlive(originalParentPid);
    if (process.ppid === 1 || parentMissing) {
      requestParentGoneShutdown(`parent-pid=${originalParentPid}, current-ppid=${process.ppid}`);
    }
  }, 2_000);
  parentWatchdog.unref?.();
}

logStartup('debug', `Server child starting (cwd=${process.cwd()}, dir=${dir}, port=${port})`);

initDatabase().then(async () => {
  logStartup('debug', 'DB initialized, bootstrapping canonical Worktree registry...');
  try {
    const userId = await resolveServerDefaultUserId();
    if (userId) {
      const settings = await SettingsManager.load(userId, { silent: true, strict: true });
      const bootstrap = await bootstrapCanonicalWorktreeRegistry(settings.agentEnvironment);
      if (bootstrap.status === 'completed') {
        logger.info({ bootstrap }, 'Canonical Worktree registry bootstrapped');
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Canonical Worktree registry bootstrap skipped');
  }
  registerCurrentProjectAtStartup();
  logStartup('debug', 'Worktree bootstrap settled, loading model config cache...');
  return ensureRemoteModelConfigLoaded();
}).then(() => {
  logStartup('debug', 'Model config cache loaded, calling ensureRSAKeys...');
  return ensureRSAKeys();
}).then(() => {
  logStartup('debug', 'RSA keys ensured, calling ensureAppSecret...');
  return ensureAppSecret();
}).then(async () => {
  logStartup('debug', 'App secret ensured, creating server and calling app.prepare...');
  prewarmCliStatusSnapshot('electron-server-child');

  // Create HTTP server first so Next.js can attach its HMR upgrade handler.
  const server = createServer();

  const app = next({ dev, hostname, port, dir, httpServer: server } as Parameters<typeof next>[0]);
  const handle = app.getRequestHandler();

  await app.prepare();

  // Attach request handler after Next.js is prepared
  const attachRequestHandler = (target: Server) => {
    target.on('request', (req, res) => {
      attachRemoteAddressHeader(req);
      const pathname = req.url?.split('?')[0] ?? '';
      if (pathname === CONTROL_ROUTE_PREFIX || pathname.startsWith(`${CONTROL_ROUTE_PREFIX}/`)) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'POST' && req.url?.split('?')[0] === '/__tessera/hook') {
        void handleHookRequest(req, res);
        return;
      }
      handle(req, res);
    });
  };
  attachRequestHandler(server);

  directListeners.configure({
    port,
    createListener: () => {
      const listener = createServer();
      attachRequestHandler(listener);
      wsServer.attach(listener);
      return listener;
    },
    // Resolved on every sync: the tailnet address can change between launches,
    // and Tailscale may still have been starting up when the app did.
    resolveTarget: async () => resolveDirectListenerTarget({
      platform: process.platform,
      isPackaged,
      advertisedAddress: (await loadMachineSettings()).advertisedAddress,
      interfaces: networkInterfaces(),
    }),
  });

  server.listen(port, hostname, () => {
    void (async () => {
      controlRuntime = await startControlRuntimeHost({
        appVersion: readAppVersion(dir),
        appRoot: dir,
        runtimeDirectory: process.env.TESSERA_CONTROL_RUNTIME_DIR,
        descriptorPath: process.env.TESSERA_CONTROL_DESCRIPTOR_PATH,
        resolveUserId: resolveServerDefaultUserId,
      });

      wsServer.start(server);
      startOomDiagnostics();
      // Only now can a direct listener serve /ws, so bind it after the
      // WebSocket server exists rather than alongside the loopback listen.
      await directListeners.sync();

      rateLimitPoller.setBroadcast((msg) => wsServer.broadcast(msg));
      rateLimitPoller.setEnvironmentResolver(async () => {
        const userId = await resolveServerDefaultUserId();
        if (!userId) {
          throw new Error('Electron server default user is unavailable');
        }
        return getAgentEnvironment(userId);
      });
      rateLimitPoller.start();

      // Model config: packaged Electron uses this child process instead of server.ts,
      // so it must run the same startup refresh path.
      setModelConfigBroadcast((msg) => wsServer.broadcast(msg));
      void triggerModelConfigRefresh('launch');

      // Wire PR sync broadcasts and start the background PR poller. Without
      // these the in-process subscribe callbacks on syncTaskPr/syncSessionPr
      // have no listeners, so live updates never reach Electron clients.
      installTaskPrStatusBroadcast((msg) => wsServer.broadcast(msg));
      installSessionPrStatusBroadcast((msg) => wsServer.broadcast(msg));
      void taskPrPoller.start();

      const directHosts = directListeners.activeHosts();
      logger.info(
        { port, hostname, directHosts, env: process.env.NODE_ENV },
        'Electron server started',
      );
      console.log(`> Ready on http://${hostname}:${port}`);
      console.log(`> WebSocket on ws://${hostname}:${port}/ws`);
      for (const directHost of directHosts) {
        console.log(`> Remote access on http://${directHost}:${port}`);
      }

      // Signal readiness to Electron main process only after the exact-instance
      // Control transport and provider bridge are ready.
      if (process.send) {
        process.send({ type: 'ready', port });
      }
    })().catch((error) => {
      // The IPC message still reaches the user-facing dialog, so it stays opaque. The
      // startup log is local to the user and the only place this failure can be read
      // from: the app exits without a window, so dropping the cause here leaves nothing
      // to go on. A Windows ACL regression hid behind the bare line for hours.
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      logStartup('fatal', `Failed to initialize the Control runtime: ${detail}`);
      process.send?.({ type: 'error', message: 'Failed to initialize the Control runtime' });
      void Promise.resolve(controlRuntime?.close())
        .catch(() => undefined)
        .then(() => directListeners.closeAll())
        .catch(() => undefined)
        .finally(() => server.close(() => process.exit(1)));
    });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  let isShuttingDown = false;
  const shutdown = async (reason = 'requested') => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (parentWatchdog) {
      clearInterval(parentWatchdog);
      parentWatchdog = null;
    }
    if (oomDiagnosticsTimer) {
      clearInterval(oomDiagnosticsTimer);
      oomDiagnosticsTimer = null;
    }

    const forceShutdownTimer = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);

    logger.info({ reason }, 'Shutting down server...');

    try {
      logger.info('Closing remote access listeners...');
      await directListeners.closeAll();

      logger.info('Closing WebSocket connections...');
      await wsServer.shutdown();

      logger.info('Stopping rate limit poller...');
      rateLimitPoller.stop();

      logger.info('Stopping task PR poller...');
      taskPrPoller.stop();
      uninstallTaskPrStatusBroadcast();
      uninstallSessionPrStatusBroadcast();

      logger.info('Cleaning up CLI processes...');
      await processManager.cleanup();

      logger.info('Closing Control runtime...');
      await controlRuntime?.close();
    } catch (error) {
      clearTimeout(forceShutdownTimer);
      logger.error({ error }, 'Server shutdown cleanup failed');
      process.exit(1);
    }

    server.close((error?: Error) => {
      clearTimeout(forceShutdownTimer);
      if (error) {
        logger.error({ error }, 'HTTP server close failed');
        process.exit(1);
        return;
      }
      logger.info('HTTP server closed');
      process.exit(0);
    });

    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
    }, 1_000);
  };
  shutdownHandler = shutdown;

  // IPC shutdown from Electron main process
  process.on('message', (msg: { type: string; requestId?: string; action?: string }) => {
    if (msg?.type === 'shutdown') {
      void shutdown('ipc-shutdown');
    } else if (msg?.type === 'terminal_summary_request' && typeof msg.requestId === 'string') {
      process.send?.({
        type: 'terminal_summary',
        requestId: msg.requestId,
        ...terminalManager.getRuntimeSummary(),
      });
    } else if (
      msg?.type === 'pairing_presentation_request'
      && typeof msg.requestId === 'string'
      && (msg.action === 'issue' || msg.action === 'rotate')
    ) {
      void createPairingPresentation(msg.action).then((presentation) => {
        process.send?.({
          type: 'pairing_presentation',
          requestId: msg.requestId,
          ...presentation,
        });
      }).catch((error: unknown) => {
        process.send?.({
          type: 'pairing_presentation_error',
          requestId: msg.requestId,
          code: error instanceof Error && 'code' in error ? String(error.code) : 'pairing-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  // Fallback signals for non-Electron usage
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason, reasonType: typeof reason }, 'Unhandled Rejection');
  });

  process.on('uncaughtException', (error) => {
    const msg = error.message || '';
    const isWorkerError =
      msg.includes('the worker has exited') ||
      msg.includes('the worker thread exited') ||
      msg.includes('vendor-chunks/lib/worker.js');

    if (dev && isWorkerError) {
      logger.warn({ error: msg }, 'Next.js dev worker error (non-fatal)');
      return;
    }

    logger.error({ error: msg, stack: error.stack }, 'Uncaught Exception');
    void shutdown('uncaughtException');
  });
}).catch((err) => {
  logStartup('fatal', `FATAL ERROR: ${err}`);
  if (process.send) {
    process.send({ type: 'error', message: String(err) });
  }
  console.error('Failed to prepare Next.js app:', err);
  process.exit(1);
});
