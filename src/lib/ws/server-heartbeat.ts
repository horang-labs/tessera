import type { WebSocket } from 'ws';

export const WS_HEARTBEAT_INTERVAL_MS = 15_000;

export class WebSocketServerHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: number | null = null;
  private readonly alive = new WeakSet<WebSocket>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  noteAlive(socket: WebSocket): void {
    this.alive.add(socket);
  }

  start(getClients: () => Iterable<WebSocket>): void {
    if (this.timer) return;

    this.lastTickAt = this.now();
    this.timer = setInterval(() => this.sweep(getClients()), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastTickAt = null;
  }

  private sweep(clients: Iterable<WebSocket>): void {
    const tickAt = this.now();
    const elapsedMs = tickAt - (this.lastTickAt ?? tickAt);
    this.lastTickAt = tickAt;
    const resumedFromPause = elapsedMs < 0 || elapsedMs > this.intervalMs * 1.5;

    for (const socket of clients) {
      if (resumedFromPause) {
        // A delayed server tick cannot infer that clients missed a probe they
        // had no chance to answer while the host was suspended.
        this.alive.add(socket);
      }
      if (!this.alive.has(socket)) {
        socket.terminate();
        continue;
      }
      this.alive.delete(socket);
      try {
        socket.ping();
      } catch {
        // A socket already tearing down is finalized by its close/error path.
      }
    }
  }
}
