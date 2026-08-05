import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { ServerTransportMessage } from './message-types';
import { processManager } from '../cli/process-manager';
import { protocolAdapter } from '../cli/protocol-adapter';
import {
  evaluateRequestAndLog,
  parseRequestUrl,
  type CredentialKind,
  type RequestGateInput,
} from '../auth/request-gate';
import { getCachedRateLimitData } from '../rate-limit/fetcher';
import { skillAnalysisService } from '../skill/skill-analysis-service';
import { buildClaudeRateLimitSnapshot } from '../status-display/rate-limit-snapshots';
import { rateLimitPoller } from '../rate-limit/poller';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import { installDiffStatsBroadcast } from '../git/worktree-diff-stats-broadcast';
import {
  installDiffStatsSafetySweep,
  uninstallDiffStatsSafetySweep,
} from '../git/diff-stats-safety-sweep-runner';
import { installGitPanelBroadcast } from '../git/git-panel-broadcast';
import { bindTerminalRuntimeSender, terminalManager } from '../terminal/shared-terminal-manager';
import { workspaceFileWatchManager } from '../workspace-files/workspace-file-watch-manager';
import { getGeneratingTitleSessionIds } from './title-generation-state';
import {
  logReceivedClientTransportMessage,
  parseClientTransportMessage,
  routeClientTransportMessage,
  verifyClientSessionAccess,
} from './server-message-routing';
import { WebSocketServerHeartbeat, WS_HEARTBEAT_INTERVAL_MS } from './server-heartbeat';
import { isDeviceRegistered } from '../auth/device-registry';

// Supports five 5MiB image attachments after base64 expansion; lowering this
// to a generic RPC-sized cap would break the existing composer contract.
export const WS_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_WS_CONNECTIONS = 128;
export const MAX_TCP_CONNECTIONS = MAX_WS_CONNECTIONS * 2;
const WS_REJECTION_GRACE_MS = 1_000;

interface WebSocketServerOptions {
  maxConnections?: number;
  heartbeatIntervalMs?: number;
  rejectionGraceMs?: number;
}

export interface WebSocketIdentity {
  userId: string;
  kind: CredentialKind;
  deviceId?: string;
}

export interface WebSocketConnectionInfo extends WebSocketIdentity {
  connectionId: string;
}

interface AuthenticatedWebSocket extends WebSocket {
  connectionId?: string;
  identity?: WebSocketIdentity;
}

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = segment.slice(separator + 1).trim();
  }
  return cookies;
}

function requestGateInputFromUpgrade(req: IncomingMessage): RequestGateInput {
  const headers = Object.fromEntries(
    Object.entries(req.headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return [[name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]];
    }),
  );

  return {
    purpose: 'ws-upgrade',
    method: req.method ?? 'GET',
    rawUrl: req.url ?? '',
    host: headers.host ?? '',
    origin: headers.origin ?? '',
    cookies: parseCookieHeader(headers.cookie ?? ''),
    headers,
  };
}

function parseUpgradePath(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

export class WebSocketServer {
  private wss: WSServer | null = null;
  private connections = new Map<string, Set<AuthenticatedWebSocket>>();
  private rateLimitCache = new Map<string, Map<string, Extract<ServerTransportMessage, { type: 'rate_limit_update' }>>>();
  private analysisUnsubscribe: (() => void) | null = null;
  private readonly maxConnections: number;
  private readonly rejectionGraceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeat: WebSocketServerHeartbeat;

  constructor(options: WebSocketServerOptions = {}) {
    this.maxConnections = options.maxConnections ?? MAX_WS_CONNECTIONS;
    this.rejectionGraceMs = options.rejectionGraceMs ?? WS_REJECTION_GRACE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
    this.heartbeat = new WebSocketServerHeartbeat(this.heartbeatIntervalMs);
  }

  /**
   * Start WebSocket server
   */
  start(httpServer: import('http').Server): void {
    // The TCP cap also covers clients that never complete an HTTP or WebSocket
    // handshake, while the lower WebSocket cap bounds upgraded connections.
    httpServer.maxConnections = MAX_TCP_CONNECTIONS;
    // Use noServer mode so ws doesn't intercept ALL upgrade requests on the
    // HTTP server.  Next.js 16 auto-attaches its own upgrade listener for HMR
    // (_next/webpack-hmr); if ws grabs every upgrade first, HMR gets a 400.
    this.wss = new WSServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

    this.wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Only handle upgrade requests destined for /ws
    httpServer.on('upgrade', (req, socket, head) => {
      // Tessera must not validate or consume unrelated upgrades. In
      // development, Next.js owns its HMR WebSocket on this same server.
      if (parseUpgradePath(req.url) !== '/ws') return;

      const input = requestGateInputFromUpgrade(req);
      const parsedUrl = parseRequestUrl(input);
      if (!parsedUrl) {
        void evaluateRequestAndLog(input)
          .catch((error) => logger.error({ error }, 'Malformed WebSocket upgrade gate failed'))
          .finally(() => socket.destroy());
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        if (this.wss!.clients.size > this.maxConnections) {
          logger.warn({ maxConnections: this.maxConnections }, 'WebSocket connection rejected: capacity reached');
          this.rejectConnection(ws, 1013, 'Maximum connections reached');
          return;
        }
        this.wss!.emit('connection', ws, req);
      });
    });

    // Setup protocol adapter callback
    protocolAdapter.setSendToUser((userId, message) => {
      this.sendToUser(userId, message);
    });
    bindTerminalRuntimeSender((userId, message) => {
      this.sendToUser(userId, message);
    });

    // Relay worktree diff-stats updates to connected users
    installDiffStatsBroadcast();
    // Backstop for when every push trigger goes quiet at once (see the sweep module)
    installDiffStatsSafetySweep(() => this.connections.keys());
    // Relay git panel state updates (commits, branch, changedFiles, prStatus)
    installGitPanelBroadcast();

    // Wire skill analysis progress to requesting user's connections
    this.analysisUnsubscribe = skillAnalysisService.subscribe((state) => {
      if (state.requestedBy && state.status !== 'idle') {
        this.sendToUser(state.requestedBy, {
          type: 'skill_analysis_progress',
          status: state.status,
          skillCount: state.skillCount,
          error: state.error,
          result: state.result,
          startedAt: state.startedAt,
          model: state.model,
          generatedAt: state.result?.generatedAt || state.startedAt,
          completedCount: state.completedCount,
          totalCount: state.totalCount,
          currentJobs: state.currentJobs,
        });
      }
    });

    this.heartbeat.start(() => this.wss?.clients ?? []);

    logger.info({
      path: '/ws',
      pingInterval: this.heartbeatIntervalMs,
      maxConnections: this.maxConnections,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
    }, 'WebSocket server started');
  }

  listConnections(): WebSocketConnectionInfo[] {
    const result: WebSocketConnectionInfo[] = [];
    for (const sockets of this.connections.values()) {
      for (const socket of sockets) {
        if (!socket.connectionId || !socket.identity) continue;
        result.push({
          connectionId: socket.connectionId,
          ...socket.identity,
        });
      }
    }
    return result;
  }

  disconnectDevice(deviceId: string): number {
    let disconnected = 0;
    for (const sockets of this.connections.values()) {
      for (const socket of sockets) {
        if (socket.identity?.deviceId !== deviceId) continue;
        socket.terminate();
        disconnected += 1;
      }
    }
    return disconnected;
  }

  /**
   * Send message to a specific user (broadcasts to all their connections)
   */
  sendToUser(userId: string, message: ServerTransportMessage): void {
    sessionHistory.recordTransportMessage(message);

    if (message.type === 'rate_limit_update') {
      const cachedByProvider = this.rateLimitCache.get(userId) ?? new Map();
      cachedByProvider.set(message.providerId, message);
      this.rateLimitCache.set(userId, cachedByProvider);
    }

    const wsSet = this.connections.get(userId);

    if (!wsSet || wsSet.size === 0) {
      logger.warn({ userId }, 'Cannot send to user, no connections');
      return;
    }

    const payload = JSON.stringify(message);

    for (const ws of wsSet) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      try {
        const startTime = Date.now();
        ws.send(payload);
        const duration = Date.now() - startTime;

        if (duration > 50) {
          logger.warn({ userId, duration, messageType: message.type }, 'WebSocket send slow');
        }
      } catch (err) {
        logger.error({
          userId,
          error: err,
          messageType: message.type,
          }, 'Failed to send message');
      }
    }
  }

  /** Send a transport message only to the renderer connection that owns a terminal surface. */
  sendToConnectionId(connectionId: string, message: ServerTransportMessage): void {
    for (const wsSet of this.connections.values()) {
      for (const ws of wsSet) {
        if (ws.connectionId !== connectionId || ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(JSON.stringify(message));
        } catch (error) {
          logger.error({ connectionId, error, messageType: message.type }, 'Failed to send connection message');
        }
        return;
      }
    }
  }

  private sendToConnection(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: ServerTransportMessage,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      logger.error({
        userId,
        error: err,
        messageType: message.type,
      }, 'Failed to send message to WebSocket connection');
    }
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: AuthenticatedWebSocket, req: IncomingMessage): Promise<void> {
    const identity = await this.authenticate(req);

    if (!identity) {
      logger.warn('WebSocket connection rejected: authentication failed');
      this.rejectConnection(ws, 1008, 'Unauthorized');
      return;
    }

    // Authentication and connection registration are separated by an await.
    // If revocation won that race, never add a socket that the revoker could
    // not yet see; otherwise registration stays synchronous until it is listed.
    if (
      identity.kind === 'device'
      && (!identity.deviceId || !isDeviceRegistered(identity.deviceId))
    ) {
      logger.warn({ deviceId: identity.deviceId }, 'Revoked device WebSocket rejected');
      ws.terminate();
      return;
    }

    const { userId } = identity;
    ws.connectionId = randomUUID();
    ws.identity = identity;
    terminalManager.registerConnection(ws.connectionId);

    // Add to connection set for this user
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);

    logger.info({ userId, totalConnections: this.connections.get(userId)!.size }, 'WebSocket connected');

    this.heartbeat.noteAlive(ws);

    // Setup pong handler
    ws.on('pong', () => {
      this.heartbeat.noteAlive(ws);
      logger.debug({ userId }, 'WebSocket pong received');
    });

    // Setup event handlers
    ws.on('message', (data: Buffer) => {
      this.heartbeat.noteAlive(ws);
      this.handleMessage(ws, data);
    });

    ws.on('close', () => {
      if (ws.connectionId) {
        workspaceFileWatchManager.unsubscribeConnection(ws.connectionId);
        terminalManager.detachConnection(ws.connectionId);
      }
      const wsSet = this.connections.get(userId);
      if (wsSet) {
        wsSet.delete(ws);
        logger.info({ userId, remainingConnections: wsSet.size }, 'WebSocket closed');

        if (wsSet.size === 0) this.connections.delete(userId);
      }
    });

    ws.on('error', (err) => {
      logger.error({ userId, error: err }, 'WebSocket error');
    });

    // Send initial session list (actual sessions for this user, not empty)
    const userProcesses = processManager.getUserProcesses(userId);
    const sessions = await Promise.all(userProcesses.map(async (p) => {
      const replayState = await sessionHistory.readReplayState(p.sessionId, { lazyToolOutput: true })
        .catch((err) => {
          logger.warn({
            userId,
            sessionId: p.sessionId,
            error: err,
          }, 'Failed to read replay state for initial session list');
          return null;
        });

      return {
        id: p.sessionId,
        status: p.status,
        isGenerating: p.isGenerating,
        createdAt: p.createdAt.toISOString(),
        activeInteractivePrompt: replayState?.activeInteractivePrompt ?? null,
        todoSnapshot: replayState?.todoSnapshot ?? [],
      };
    }));
    this.sendToConnection(ws, userId, {
      type: 'session_list',
      sessions,
      titleGeneratingSessionIds: getGeneratingTitleSessionIds(userId),
    });
    this.sendToConnection(ws, userId, {
      type: 'terminal_session_runtime_snapshot',
      activeSessionIds: [...terminalManager.getActiveSessionIds(userId)],
      reboundSessions: terminalManager.getSessionReboundsForUser(userId),
    });

    // Hook state is process state, not a transient WebSocket event. Replay the
    // latest state only to this new connection so a renderer reload retains
    // completed/input-required badges without duplicating other windows.
    for (const message of terminalManager.getSessionStatesForUser(userId)) {
      this.sendToConnection(ws, userId, message);
    }

    // Send cached rate limit data to new connection
    const cachedRateLimit = getCachedRateLimitData();
    const sentProviders = new Set<string>();
    if (cachedRateLimit) {
      this.sendToUser(userId, {
        type: 'rate_limit_update',
        ...buildClaudeRateLimitSnapshot(cachedRateLimit),
      });
      sentProviders.add('claude-code');
    }

    for (const snapshot of rateLimitPoller.getCachedSnapshots()) {
      if (sentProviders.has(snapshot.providerId)) continue;
      this.sendToUser(userId, {
        type: 'rate_limit_update',
        ...snapshot,
      });
      sentProviders.add(snapshot.providerId);
    }

    const cachedProviderLimits = this.rateLimitCache.get(userId);
    if (cachedProviderLimits) {
      for (const [providerId, message] of cachedProviderLimits) {
        if (sentProviders.has(providerId)) continue;
        this.sendToUser(userId, message);
      }
    }

    // Send current skill analysis state if in-flight or recently completed/failed
    const analysisState = skillAnalysisService.getState();
    const aStatus = analysisState.status;
    if (aStatus === 'scanning' || aStatus === 'analyzing' || aStatus === 'completed' || aStatus === 'failed') {
      this.sendToUser(userId, {
        type: 'skill_analysis_progress',
        status: aStatus,
        skillCount: analysisState.skillCount,
        error: analysisState.error,
        result: analysisState.result,
        startedAt: analysisState.startedAt,
        model: analysisState.model,
        generatedAt: analysisState.result?.generatedAt || analysisState.startedAt,
        completedCount: analysisState.completedCount,
        totalCount: analysisState.totalCount,
        currentJobs: analysisState.currentJobs,
      });
    }
  }

  /**
   * Broadcast a message to all connected users.
   */
  broadcast(message: ServerTransportMessage): void {
    for (const userId of this.connections.keys()) {
      this.sendToUser(userId, message);
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(ws: AuthenticatedWebSocket, data: Buffer): Promise<void> {
    const userId = ws.identity!.userId;
    let requestId: string | undefined;

    try {
      const message = parseClientTransportMessage(data);
      requestId = message.requestId;
      logReceivedClientTransportMessage(userId, message);

      if (!verifyClientSessionAccess(userId, message, this.sendToUser.bind(this))) {
        return;
      }

      await routeClientTransportMessage({
        connectionId: ws.connectionId!,
        userId,
        message,
        sendToUser: this.sendToUser.bind(this),
        sendToConnection: this.sendToConnectionId.bind(this),
      });
    } catch (err) {
      logger.error({
        userId,
        error: err,
        }, 'Failed to handle message');

      this.sendToUser(userId, {
        type: 'error',
        ...(requestId ? { requestId } : {}),
        code: 'internal_error',
        message: 'Failed to process message',
      });
    }
  }

  /**
   * Authenticate WebSocket connection via cookie JWT
   */
  private async authenticate(req: IncomingMessage): Promise<WebSocketIdentity | null> {
    try {
      const input = requestGateInputFromUpgrade(req);
      const decision = await evaluateRequestAndLog(input);
      if (!decision.allow) return null;

      logger.debug({ userId: decision.userId, kind: decision.kind }, 'WebSocket authenticated');
      return {
        userId: decision.userId,
        kind: decision.kind,
        ...(decision.deviceId ? { deviceId: decision.deviceId } : {}),
      };
    } catch (err) {
      logger.error({ error: err }, 'WebSocket auth error');
      return null;
    }
  }

  private rejectConnection(ws: WebSocket, code: number, reason: string): void {
    // A peer on a suspended or broken link may never acknowledge the close
    // frame. Bound that wait so rejected sockets cannot consume the cap.
    ws.on('error', () => {});
    ws.close(code, reason);
    const terminateTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }, this.rejectionGraceMs);
    terminateTimer.unref?.();
    ws.once('close', () => clearTimeout(terminateTimer));
  }

  /**
   * Graceful shutdown (called by server.ts)
   */
  async shutdown(): Promise<void> {
    this.heartbeat.stop();
    uninstallDiffStatsSafetySweep();
    this.analysisUnsubscribe?.();
    this.analysisUnsubscribe = null;
    await terminalManager.shutdownAll();

    if (!this.wss) return;

    // Close all connections
    this.wss.clients.forEach((ws) => {
      ws.close(1000, 'Server shutting down');
    });

    // Close WebSocket server
    await new Promise<void>((resolve) => {
      this.wss!.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    });
  }
}

// Singleton instance (globalThis to survive Next.js hot reload and webpack/tsx module boundary)
const WS_SERVER_KEY = Symbol.for('tessera.wsServer');
const _wsServerGlobal = globalThis as unknown as Record<symbol, WebSocketServer>;
export const wsServer: WebSocketServer =
  _wsServerGlobal[WS_SERVER_KEY] || (_wsServerGlobal[WS_SERVER_KEY] = new WebSocketServer());
