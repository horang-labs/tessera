import './electron/register-runtime-aliases';
import next from 'next';
import { createServer } from 'http';
import { initDatabase } from './src/lib/db/database';
import './src/lib/cli/providers/bootstrap';
import { wsServer } from './src/lib/ws/server';
import { processManager } from './src/lib/cli/process-manager';
import { rateLimitPoller } from './src/lib/rate-limit/poller';
import { taskPrPoller } from './src/lib/github/task-pr-poller';
import { installTaskPrStatusBroadcast, uninstallTaskPrStatusBroadcast } from './src/lib/github/task-pr-broadcast';
import { ensureRSAKeys } from './src/lib/auth/keys';
import { readUsersFile } from './src/lib/users';
import { SettingsManager } from './src/lib/settings/manager';
import { pruneExpiredArchivedWorktrees } from './src/lib/archive/archive-service';
import { prewarmProviderStatusCache } from './src/lib/cli/provider-status-prewarm';
import logger from './src/lib/logger';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.TESSERA_HOST || process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  await initDatabase();
  await ensureRSAKeys();
  prewarmProviderStatusCache('server');
  try {
    const users = await readUsersFile();
    const userId = users.users[0]?.id;
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

  const app = next({ dev, hostname, port, httpServer: server } as Parameters<typeof next>[0]);
  const handle = app.getRequestHandler();

  await app.prepare();

  // Attach request handler after Next.js is prepared
  server.on('request', (req, res) => {
    handle(req, res);
  });

  // WebSocket upgrade handling:
  // - /ws: handled by wsServer (ws library with path: '/ws' auto-handles upgrade)
  // - HMR: Next.js 16 auto-attaches via setupWebSocketHandler(httpServer)

  // Start HTTP server, then attach WebSocket
  server.on('error', (error) => {
    logger.error({ error }, 'Server failed to listen');
    process.exit(1);
  });

  server.listen(port, hostname, () => {
    // Start WebSocket server on the same HTTP server
    wsServer.start(server);

    // Start rate limit poller
    rateLimitPoller.setBroadcast((msg) => wsServer.broadcast(msg));
    rateLimitPoller.start();

    // Start task PR poller + relay updates to connected clients
    installTaskPrStatusBroadcast((msg) => wsServer.broadcast(msg));
    void taskPrPoller.start();

    logger.info({
      port,
      hostname,
      env: process.env.NODE_ENV || 'development',
      }, 'Server started');
    const displayHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
    if (process.env.TESSERA_CLI === '1') {
      console.log(`\nTessera is running at:\n  http://${displayHost}:${port}\n\nPress Ctrl+C to stop.\n`);
    } else {
      console.log(`> Ready on http://${displayHost}:${port}`);
      console.log(`> WebSocket on ws://${displayHost}:${port}/ws`);
    }
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

      // processManager.cleanup() kills every spawned CLI plus its process
      // group (spawn-cli-runtime marks children as detached: true on Unix,
      // process-termination uses taskkill /T on Windows). This is the step
      // that prevents CLI-spawned descendants from lingering as orphans.
      logger.info('Cleaning up CLI processes...');
      await processManager.cleanup();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown cleanup');
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
