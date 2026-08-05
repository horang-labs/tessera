import './runtime/register-runtime-aliases';
import next from 'next';
import { loadEnvConfig } from '@next/env';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { initDatabase } from './src/lib/db/database';
import { interruptRunningPreparations } from './src/lib/db/task-preparation';
import { markServerShuttingDown } from './src/lib/server-lifecycle';
import './src/lib/cli/providers/bootstrap';
import { wsServer } from './src/lib/ws/server';
import { processManager } from './src/lib/cli/process-manager';
import { rateLimitPoller } from './src/lib/rate-limit/poller';
import { taskPrPoller } from './src/lib/github/task-pr-poller';
import { installTaskPrStatusBroadcast, uninstallTaskPrStatusBroadcast } from './src/lib/github/task-pr-broadcast';
import { installSessionPrStatusBroadcast, uninstallSessionPrStatusBroadcast } from './src/lib/github/session-pr-broadcast';
import { ensureRSAKeys } from './src/lib/auth/keys';
import { ensureAppSecret } from './src/lib/auth/app-secret';
import { resolveServerDefaultUserId } from './src/lib/server-default-user';
import { SettingsManager } from './src/lib/settings/manager';
import { pruneExpiredArchivedWorktrees } from './src/lib/archive/archive-service';
import { prewarmCliStatusSnapshot } from './src/lib/cli/provider-status-prewarm';
import { snapshotTelemetryStartupDataState } from './src/lib/telemetry/server-state';
import { setModelConfigBroadcast, triggerModelConfigRefresh } from './src/lib/model-config/refresh';
import { ensureRemoteModelConfigLoaded } from './src/lib/model-config/remote-config';
import logger from './src/lib/logger';
import { getServerPort } from './src/lib/server-port';
import { handleHookRequest } from './src/lib/cli/hook-receiver';
import { warmWindowsConptyOnce } from './src/lib/terminal/windows-conpty-warmup';
import { readAppVersion } from './src/lib/app-version';
import {
  CONTROL_ROUTE_PREFIX,
} from './src/lib/control/http-handler';
import {
  startControlRuntimeHost,
  type ControlRuntimeHost,
} from './src/lib/control/runtime-host';
import { attachRemoteAddressHeader } from './src/lib/http/remote-address-header';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.TESSERA_HOST || process.env.HOST || '127.0.0.1';
const port = getServerPort();
const dir = process.env.TESSERA_APP_ROOT || process.cwd();

loadEnvConfig(dir, dev, console, true);
snapshotTelemetryStartupDataState();

async function startServer() {
  await initDatabase();
  // A preparation PTY does not survive the app, so any status still claiming to
  // be running describes a process that is gone — and a worktree that may be
  // half prepared.
  interruptRunningPreparations();
  // Warm the model-config store from disk (no network) so the first API request
  // serving provider options already reflects the last known remote list.
  await ensureRemoteModelConfigLoaded();
  await ensureRSAKeys();
  await ensureAppSecret();
  prewarmCliStatusSnapshot('server');
  try {
    const userId = await resolveServerDefaultUserId();
    if (userId) {
      const settings = await SettingsManager.load(userId);
      if (settings.autoDeleteArchivedWorktrees) {
        await pruneExpiredArchivedWorktrees(settings.archivedWorktreeRetentionDays);
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Archived worktree retention skipped during startup');
  }

  // Create HTTP server first so Next.js can attach its HMR upgrade handler.
  // In Next.js 16, setupWebSocketHandler() auto-registers on options.httpServer
  // to handle _next/webpack-hmr WebSocket upgrades for HMR.
  const server = createServer();
  let controlRuntime: ControlRuntimeHost | null = null;

  const app = next({ dev, hostname, port, dir, httpServer: server } as Parameters<typeof next>[0]);
  const handle = app.getRequestHandler();

  await app.prepare();

  // Attach request handler after Next.js is prepared
  server.on('request', (req, res) => {
    attachRemoteAddressHeader(req);
    const pathname = req.url?.split('?')[0] ?? '';
    if (pathname === CONTROL_ROUTE_PREFIX || pathname.startsWith(`${CONTROL_ROUTE_PREFIX}/`)) {
      res.writeHead(404).end();
      return;
    }

    // 상태 사이드채널: PTY claude 훅만 여기서 처리하고 Next로 넘기지 않는다.
    if (req.method === 'POST' && req.url) {
      if (pathname === '/__tessera/hook') {
        void handleHookRequest(req, res);
        return;
      }
    }
    handle(req, res);
  });

  // WebSocket upgrade handling:
  // - /ws: handled by wsServer (ws library with path: '/ws' auto-handles upgrade)
  // - HMR: Next.js 16 auto-attaches via setupWebSocketHandler(httpServer)

  // Start HTTP server, then attach WebSocket
  server.on('error', (error) => {
    logger.error({ error }, 'Server failed to listen');
    void Promise.resolve(controlRuntime?.close())
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });

  server.listen(port, hostname, () => {
    void (async () => {
      const listeningPort = (server.address() as AddressInfo).port;
      const appVersion = readAppVersion(dir);
      controlRuntime = await startControlRuntimeHost({
        appVersion,
        appRoot: dir,
        runtimeDirectory: process.env.TESSERA_CONTROL_RUNTIME_DIR,
        descriptorPath: process.env.TESSERA_CONTROL_DESCRIPTOR_PATH,
      });

      // Start WebSocket server on the same HTTP server
      wsServer.start(server);

      // Pay the first ConPTY spawn cost (~seconds on Windows) before the user
      // opens their first terminal.
      warmWindowsConptyOnce();

      // Start rate limit poller
      rateLimitPoller.setBroadcast((msg) => wsServer.broadcast(msg));
      rateLimitPoller.start();

      // Model config: one refresh per launch (doubles as the launch-count ping). No periodic
      // poll — every Claude session creation triggers its own refresh ('session' event).
      setModelConfigBroadcast((msg) => wsServer.broadcast(msg));
      void triggerModelConfigRefresh('launch');

      // Start task PR poller + relay updates to connected clients
      installTaskPrStatusBroadcast((msg) => wsServer.broadcast(msg));
      installSessionPrStatusBroadcast((msg) => wsServer.broadcast(msg));
      void taskPrPoller.start();

      logger.info({
        port: listeningPort,
        hostname,
        env: process.env.NODE_ENV || 'development',
      }, 'Server started');
      const displayHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
      if (process.env.TESSERA_CLI === '1') {
        console.log(`\nTessera is running at:\n  http://${displayHost}:${listeningPort}\n\nPress Ctrl+C to stop.\n`);
      } else {
        console.log(`> Ready on http://${displayHost}:${listeningPort}`);
        console.log(`> WebSocket on ws://${displayHost}:${listeningPort}/ws`);
      }
    })().catch((error) => {
      // Descriptor errors can include its private path. Keep startup logging
      // intentionally opaque while still failing closed.
      void error;
      logger.error('Failed to initialize the Control runtime');
      void Promise.resolve(controlRuntime?.close())
        .catch(() => undefined)
        .finally(() => server.close(() => process.exit(1)));
    });
  });

  // Graceful shutdown. Guard against duplicate signals (double Ctrl+C, SIGTERM
  // after SIGINT, uncaughtException during shutdown) so we only run the cleanup
  // sequence once.
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress, ignoring duplicate signal');
      return;
    }
    shuttingDown = true;
    // Before anything is torn down: the PTYs about to be killed must not have
    // their deaths mistaken for scripts finishing.
    markServerShuttingDown();

    logger.info({ signal }, 'Shutting down server...');

    // Hard deadline regardless of what cleanup does.  Armed first so a hung
    // cleanup step still results in process exit.
    const forceExitTimer = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    try {
      logger.info('Closing WebSocket connections...');
      await wsServer.shutdown();

      logger.info('Stopping rate limit poller...');
      rateLimitPoller.stop();

      logger.info('Stopping task PR poller...');
      taskPrPoller.stop();
      uninstallTaskPrStatusBroadcast();
      uninstallSessionPrStatusBroadcast();

      // processManager.cleanup() kills every spawned CLI plus its process
      // group (spawn-cli-runtime marks children as detached: true on Unix,
      // process-termination uses taskkill /T on Windows). This is the step
      // that prevents CLI-spawned descendants from lingering as orphans.
      logger.info('Cleaning up CLI processes...');
      await processManager.cleanup();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown cleanup');
    }

    try {
      logger.info('Closing Control runtime...');
      await controlRuntime?.close();
    } catch {
      // Filesystem failures often include the descriptor path. Do not attach
      // the raw error to logs for this credential-bearing lifecycle.
      logger.error('Failed to close the Control runtime cleanly');
    }

    server.close(() => {
      clearTimeout(forceExitTimer);
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  process.on('unhandledRejection', (reason) => {
    logger.error({
      reason,
      reasonType: typeof reason,
      }, 'Unhandled Rejection');
  });

  process.on('uncaughtException', (error) => {
    const msg = error.message || '';

    // Next.js dev worker restart errors are non-fatal
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
}

startServer().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
