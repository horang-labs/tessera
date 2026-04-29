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
import { rateLimitPoller } from '../src/lib/rate-limit/poller';
import { prewarmProviderStatusCache } from '../src/lib/cli/provider-status-prewarm';
import logger from '../src/lib/logger';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '127.0.0.1';
const port = parseInt(process.env.PORT || '3000', 10);
// In packaged apps, cwd must be a real directory while Next should still resolve
// assets from the packaged app root (typically resources/app.asar).
const dir = process.env.TESSERA_APP_ROOT || process.cwd();

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const STARTUP_LOG = path.join(os.homedir(), '.tessera', 'startup.log');
function logStartup(msg: string) {
  fs.mkdirSync(path.dirname(STARTUP_LOG), { recursive: true });
  fs.appendFileSync(STARTUP_LOG, `[${new Date().toISOString()}] ${msg}\n`);
}

logStartup(`Server child starting (cwd=${process.cwd()}, dir=${dir}, port=${port})`);

initDatabase().then(() => {
  logStartup('DB initialized, calling ensureRSAKeys...');
  return ensureRSAKeys();
}).then(async () => {
  logStartup('RSA keys ensured, creating server and calling app.prepare...');
  prewarmProviderStatusCache('electron-server-child');

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
    rateLimitPoller.start();

    logger.info({ port, hostname, env: process.env.NODE_ENV }, 'Electron server started');
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket on ws://${hostname}:${port}/ws`);

    // Signal readiness to Electron main process
    if (process.send) {
      process.send({ type: 'ready', port });
    }
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = async () => {
    logger.info('Shutting down server...');

    logger.info('Closing WebSocket connections...');
    await wsServer.shutdown();

    logger.info('Stopping rate limit poller...');
    rateLimitPoller.stop();

    logger.info('Cleaning up CLI processes...');
    await processManager.cleanup();

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  // IPC shutdown from Electron main process
  process.on('message', (msg: { type: string }) => {
    if (msg?.type === 'shutdown') {
      shutdown();
    }
  });

  // Fallback signals for non-Electron usage
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

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
    shutdown();
  });
}).catch((err) => {
  logStartup(`FATAL ERROR: ${err}`);
  if (process.send) {
    process.send({ type: 'error', message: String(err) });
  }
  console.error('Failed to prepare Next.js app:', err);
  process.exit(1);
});
