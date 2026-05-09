import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { ServerTransportMessage } from './message-types';
import { processManager } from '../cli/process-manager';
import { protocolAdapter } from '../cli/protocol-adapter';
import { verifyToken } from '../auth/jwt';
import { isElectronAuthBypassEnabled } from '../auth/electron-mode';
import { getElectronAuthUserId } from '../auth/electron-user';
import { findUserById } from '../users';
import { getCachedRateLimitData } from '../rate-limit/fetcher';
import { skillAnalysisService } from '../skill/skill-analysis-service';
import { buildClaudeRateLimitSnapshot } from '../status-display/rate-limit-snapshots';
import logger from '../logger';
import { sessionHistory } from '../session-history';
import { installDiffStatsBroadcast } from '../git/worktree-diff-stats-broadcast';
import { installGitPanelBroadcast } from '../git/git-panel-broadcast';
import { terminalManager } from '../terminal/shared-terminal-manager';
import {
  logReceivedClientTransportMessage,
  parseClientTransportMessage,
  routeClientTransportMessage,
  verifyClientSessionAccess,
} from './server-message-routing';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  username?: string;
  isAlive?: boolean; // For ping/pong tracking
}

export class WebSocketServer {
  private wss: WSServer | null = null;
  private connections = new Map<string, Set<AuthenticatedWebSocket>>();
  private rateLimitCache = new Map<string, Map<string, Extract<ServerTransportMessage, { type: 'rate_limit_update' }>>>();
  private pingInterval: NodeJS.Timeout | null = null;
  private analysisUnsubscribe: (() => void) | null = null;
  private readonly PING_INTERVAL = 30000; // 30 seconds

  /**
   * Start WebSocket server
   */
  start(httpServer: import('http').Server): void {
    const WS_MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50MB: supports 5 images × 5MB × base64 1.33x
    // Use noServer mode so ws doesn't intercept ALL upgrade requests on the
    // HTTP server.  Next.js 16 auto-attaches its own upgrade listener for HMR
    // (_next/webpack-hmr); if ws grabs every upgrade first, HMR gets a 400.
    this.wss = new WSServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

    this.wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Only handle upgrade requests destined for /ws
    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url || '', `http://${req.headers.host}`);
      if (pathname === '/ws') {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      }
      // Non-/ws upgrades fall through to Next.js's auto-registered handler
    });

    // Setup protocol adapter callback
    protocolAdapter.setSendToUser((userId, message) => {
      this.sendToUser(userId, message);
    });

    // Relay worktree diff-stats updates to connected users
    installDiffStatsBroadcast();
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

    // Start ping/pong heartbeat
    this.startPingPong();

    logger.info({ path: '/ws', pingInterval: this.PING_INTERVAL }, 'WebSocket server started');
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

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: AuthenticatedWebSocket, req: IncomingMessage): Promise<void> {
    const userId = await this.authenticate(req);

    if (!userId) {
      logger.warn('WebSocket connection rejected: authentication failed');
      ws.close(1008, 'Unauthorized');
      return;
    }

    ws.userId = userId;

    // Add to connection set for this user
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);

    logger.info({ userId, totalConnections: this.connections.get(userId)!.size }, 'WebSocket connected');

    // Set initial alive state
    ws.isAlive = true;

    // Setup pong handler
    ws.on('pong', () => {
      ws.isAlive = true;
      logger.debug({ userId }, 'WebSocket pong received');
    });

    // Setup event handlers
    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data);
    });

    ws.on('close', () => {
      const wsSet = this.connections.get(userId);
      if (wsSet) {
        wsSet.delete(ws);
        logger.info({ userId, remainingConnections: wsSet.size }, 'WebSocket closed');

        if (wsSet.size === 0) {
          this.connections.delete(userId);
          terminalManager.closeAllForUser(userId);
        }
      }
    });

    ws.on('error', (err) => {
      logger.error({ userId, error: err }, 'WebSocket error');
    });

    // Send initial session list (actual sessions for this user, not empty)
    const userProcesses = processManager.getUserProcesses(userId);
    this.sendToUser(userId, {
      type: 'session_list',
      sessions: userProcesses.map(p => ({
        id: p.sessionId,
        status: p.status,
        isGenerating: p.isGenerating,
        createdAt: p.createdAt.toISOString(),
      })),
    });

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
    const userId = ws.userId!;
    let requestId: string | undefined;

    try {
      const message = parseClientTransportMessage(data);
      requestId = message.requestId;
      logReceivedClientTransportMessage(userId, message);

      if (!verifyClientSessionAccess(userId, message, this.sendToUser.bind(this))) {
        return;
      }

      await routeClientTransportMessage({
        userId,
        message,
        sendToUser: this.sendToUser.bind(this),
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
  private async authenticate(req: IncomingMessage): Promise<string | null> {
    try {
      if (isElectronAuthBypassEnabled()) {
        const userId = await getElectronAuthUserId();
        if (userId) {
          logger.debug({ userId }, 'WebSocket authenticated through Electron local mode');
          return userId;
        }
      }

      // Parse cookies from request headers
      const cookieHeader = req.headers.cookie || '';
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map(c => {
          const [key, ...rest] = c.trim().split('=');
          return [key, rest.join('=')];
        })
      );

      const token = cookies['jwt'];

      if (!token) {
        logger.warn('WebSocket connection without JWT cookie');
        return null;
      }

      // Verify JWT using RSA public key (same as API routes)
      const payload = await verifyToken(token);

      if (!payload) {
        logger.warn('WebSocket JWT verification failed');
        return null;
      }

      const user = await findUserById(payload.sub);
      if (!user) {
        logger.warn({ userId: payload.sub }, 'WebSocket JWT user not found');
        return null;
      }

      logger.debug({
        userId: user.id,
        username: user.username,
        }, 'WebSocket authenticated');

      return user.id;
    } catch (err) {
      logger.error({ error: err }, 'WebSocket auth error');
      return null;
    }
  }

  /**
   * Start ping/pong heartbeat to detect dead connections
   */
  private startPingPong(): void {
    this.pingInterval = setInterval(() => {
      if (!this.wss) return;

      this.wss.clients.forEach((ws: WebSocket) => {
        const authWs = ws as AuthenticatedWebSocket;

        // Check if client responded to last ping
        if (authWs.isAlive === false) {
          logger.warn({
            userId: authWs.userId,
            }, 'WebSocket connection dead, terminating');
          return ws.terminate();
        }

        // Mark as waiting for pong
        authWs.isAlive = false;
        ws.ping();

        logger.debug({ userId: authWs.userId }, 'WebSocket ping sent');
      });
    }, this.PING_INTERVAL);

    logger.info({ interval: this.PING_INTERVAL }, 'Ping/pong heartbeat started');
  }

  /**
   * Stop ping/pong heartbeat (for graceful shutdown)
   */
  private stopPingPong(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
      logger.info('Ping/pong heartbeat stopped');
    }
  }

  /**
   * Graceful shutdown (called by server.ts)
   */
  async shutdown(): Promise<void> {
    this.stopPingPong();
    this.analysisUnsubscribe?.();
    this.analysisUnsubscribe = null;

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
