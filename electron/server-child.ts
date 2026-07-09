/**
 * Electron server child process.
 * Mirrors server.ts with IPC signaling for Electron main process coordination.
 * This file runs in a forked child process — NOT in the Electron main process.
 */
import '../runtime/register-runtime-aliases';
import next from 'next';
import { createServer } from 'http';
import { initDatabase } from '../src/lib/db/database';
import '../src/lib/cli/providers/bootstrap';
import { ensureRSAKeys } from '../src/lib/auth/keys';
import { wsServer } from '../src/lib/ws/server';
import { processManager } from '../src/lib/cli/process-manager';
import { getAgentEnvironment } from '../src/lib/cli/spawn-cli';
import { getElectronAuthUserId } from '../src/lib/auth/electron-user';
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

process.env.ELECTRON_CHILD = '1';
process.env.TESSERA_ELECTRON_SERVER = '1';
process.env.TESSERA_PRODUCTION_DB = '1';
snapshotTelemetryStartupDataState();

const dev = process.env.NODE_ENV !== 'production';
const hostname = '127.0.0.1';
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
let parentShutdownRequested = false;

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

initDatabase().then(() => {
  logStartup('debug', 'DB initialized, loading model config cache...');
  return ensureRemoteModelConfigLoaded();
}).then(() => {
  logStartup('debug', 'Model config cache loaded, calling ensureRSAKeys...');
  return ensureRSAKeys();
}).then(async () => {
  logStartup('debug', 'RSA keys ensured, creating server and calling app.prepare...');
  prewarmCliStatusSnapshot('electron-server-child');

  // Create HTTP server first so Next.js can attach its HMR upgrade handler.
  const server = createServer();

  const app = next({ dev, hostname, port, dir, httpServer: server } as Parameters<typeof next>[0]);
  const handle = app.getRequestHandler();

  await app.prepare();

  // Attach request handler after Next.js is prepared
  server.on('request', (req, res) => {
    handle(req, res);
  });

  server.listen(port, hostname, () => {
    wsServer.start(server);
    rateLimitPoller.setBroadcast((msg) => wsServer.broadcast(msg));
    rateLimitPoller.setEnvironmentResolver(async () => {
      const userId = await getElectronAuthUserId();
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

    logger.info({ port, hostname, env: process.env.NODE_ENV }, 'Electron server started');
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket on ws://${hostname}:${port}/ws`);

    // Signal readiness to Electron main process
    if (process.send) {
      process.send({ type: 'ready', port });
    }
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

    const forceShutdownTimer = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);

    logger.info({ reason }, 'Shutting down server...');

    try {
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
  process.on('message', (msg: { type: string }) => {
    if (msg?.type === 'shutdown') {
      void shutdown('ipc-shutdown');
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
