import type { Server } from 'node:http';

import logger from '../logger';

/**
 * How often to re-check for a direct listener that is wanted but not yet
 * bindable — typically because Tailscale had not finished coming up when the
 * app launched.
 */
export const DIRECT_LISTENER_RETRY_INTERVAL_MS = 60_000;

export interface DirectListenerTarget {
  /** The address to listen on, or null when loopback is enough. */
  host: string | null;
  /** Remote access is configured, but its address is not usable yet. */
  pending: boolean;
}

export interface DirectListenerRuntime {
  port: number;
  /** Build a server with the request and upgrade handlers already attached. */
  createListener: () => Server;
  resolveTarget: () => Promise<DirectListenerTarget>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

/**
 * Owns the non-loopback listeners of the packaged Electron server.
 *
 * The loopback listener is created once at startup and never touched here;
 * this registry only adds or removes the direct (typically Tailscale) one, so
 * enabling remote access takes effect without restarting the app.
 */
export class DirectListenerRegistry {
  private runtime: DirectListenerRuntime | null = null;
  private active = new Map<string, Server>();
  private retryTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private retryIntervalMs: number;

  constructor(retryIntervalMs = DIRECT_LISTENER_RETRY_INTERVAL_MS) {
    this.retryIntervalMs = retryIntervalMs;
  }

  configure(runtime: DirectListenerRuntime): void {
    this.runtime = runtime;
  }

  activeHosts(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Bring the direct listener in line with the current remote-access setting.
   * Never rejects: a listener that cannot bind must not take the app down.
   */
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile().catch((error) => {
      logger.warn({ error }, 'Direct listener sync failed');
    }));
    return this.queue;
  }

  async closeAll(): Promise<void> {
    this.stopRetries();
    const servers = [...this.active.values()];
    this.active.clear();
    await Promise.all(servers.map((server) => close(server).catch(() => undefined)));
  }

  private async reconcile(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;

    const target = await runtime.resolveTarget();

    for (const [host, server] of [...this.active]) {
      if (host === target.host) continue;
      this.active.delete(host);
      await close(server).catch(() => undefined);
      logger.info({ host }, 'Direct listener closed');
    }

    if (target.host && !this.active.has(target.host)) {
      const server = runtime.createListener();
      try {
        await listen(server, runtime.port, target.host);
        this.active.set(target.host, server);
        logger.info({ host: target.host, port: runtime.port }, 'Direct listener started');
      } catch (error) {
        await close(server).catch(() => undefined);
        logger.warn(
          { error, host: target.host, port: runtime.port },
          'Direct listener could not bind; remote access stays on loopback',
        );
      }
    }

    // Retry only while remote access is configured but unusable — an address
    // that is bound, or not wanted at all, needs no timer.
    const wantsRetry = this.active.size === 0 && (target.pending || target.host !== null);
    if (wantsRetry) this.startRetries();
    else this.stopRetries();
  }

  private startRetries(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.sync();
    }, this.retryIntervalMs);
    this.retryTimer.unref?.();
  }

  private stopRetries(): void {
    if (!this.retryTimer) return;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }
}

const DIRECT_LISTENERS_KEY = Symbol.for('tessera.directListeners');
const globalRegistry = globalThis as unknown as Record<symbol, DirectListenerRegistry>;

/**
 * Shared with the Next.js request handlers running inside the same server
 * process, so saving the remote-access setting can re-bind immediately.
 */
export const directListeners: DirectListenerRegistry =
  globalRegistry[DIRECT_LISTENERS_KEY]
  || (globalRegistry[DIRECT_LISTENERS_KEY] = new DirectListenerRegistry());
