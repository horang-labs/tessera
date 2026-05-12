import type { ClientMessage, PermissionMode, ServerTransportMessage, ContentBlock } from './message-types';
import type { ProviderMeta } from '@/lib/cli/providers/types';
import type { CliStatusEntry } from '@/lib/cli/connection-checker';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';
import { useChatStore } from '@/stores/chat-store';
import { useProvidersStore } from '@/stores/providers-store';
import {
  applyLocalInteractiveResponseStart,
  finalizeInFlightTurn,
} from '@/lib/chat/session-client-effects';
import { handleIncomingServerMessage } from './client-message-handlers';
import { applyOptimisticUserMessage, buildClientRequest } from './client-transport';
import { getClientId } from './client-id';

type ServerMessageListener = (msg: ServerTransportMessage) => void;

export class WebSocketClient {
  readonly clientId: string = getClientId();
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private userId: string | null = null;
  private providersListCallbacks: Map<string, (providers: ProviderMeta[]) => void> = new Map();
  private cliStatusCallbacks: Map<string, (results: CliStatusEntry[] | null) => void> = new Map();
  private serverMessageListeners: Set<ServerMessageListener> = new Set();
  private wasReconnect = false;

  connect(userId: string) {
    // Skip if already connected/connecting with same user
    if (this.userId === userId && this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Close existing connection if switching users
    if (this.ws && this.userId !== userId) {
      this.ws.close();
      this.ws = null;
    }

    this.userId = userId;

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      this.ws.onopen = () => {
        if (this.reconnectAttempt > 0) {
          this.wasReconnect = true;
        }
        this.reconnectAttempt = 0;
        useChatStore.getState().setConnectionStatus('connected', 0);
        // Prime the SSoT provider list so UIs mounted later read it synchronously.
        useProvidersStore.getState().fetch();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: ServerTransportMessage = JSON.parse(event.data);
          if (process.env.NODE_ENV === 'development') {
            // [DEBUG] Log every WebSocket message received on client
            const detail = msg.type === 'replay_events' ? `events=${msg.events.map(event => event.type).join(',')}` :
                           msg.type === 'notification' ? `event=${(msg as any).event}` :
                           '';
            console.log(`[WS→Client] type=${msg.type} ${detail}`, msg);
          }
          this.handleMessage(msg);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      // Browser WebSocket API automatically responds to ping with pong.
      // No explicit handler needed - this comment documents the behavior.

      this.ws.onerror = (event) => {
        // Log error with improved context
        const errorMsg = this.formatWebSocketError(event);
        console.error('WebSocket error:', errorMsg);
        useChatStore.getState().setConnectionStatus('error', this.reconnectAttempt);
      };

      this.ws.onclose = (event) => {
        const closeMsg = this.formatCloseMessage(event);
        console.warn('WebSocket closed:', closeMsg);
        this.failPendingRequestCallbacks();
        this.reconnect();
      };
    } catch (error) {
      console.error('WebSocket connection failed:', error);
      useChatStore.getState().setConnectionStatus('disconnected', 0);
    }
  }

  private handleMessage(msg: ServerTransportMessage) {
    const result = handleIncomingServerMessage({
      msg,
      providersListCallbacks: this.providersListCallbacks,
      cliStatusCallbacks: this.cliStatusCallbacks,
      wasReconnect: this.wasReconnect,
    });
    this.wasReconnect = result.wasReconnect;

    for (const listener of this.serverMessageListeners) {
      try {
        listener(msg);
      } catch (error) {
        console.error('Server message listener failed:', error);
      }
    }
  }

  subscribeServerMessages(listener: ServerMessageListener): () => void {
    this.serverMessageListeners.add(listener);
    return () => {
      this.serverMessageListeners.delete(listener);
    };
  }

  sendMessage(
    sessionId: string,
    content: string | ContentBlock[],
    skillName?: string,
    displayContent?: string | ContentBlock[],
    spawnConfig?: ({ model?: string; reasoningEffort?: string | null; permissionMode?: PermissionMode } & ProviderRuntimeControls),
  ) {
    if (!this.sendRequest('send_message', {
      sessionId,
      content,
      ...(skillName && { skillName }),
      ...(displayContent && { displayContent }),
      ...(spawnConfig && { spawnConfig }),
    })) {
      console.error('WebSocket not connected');
      return;
    }

    applyOptimisticUserMessage(sessionId, content, skillName, displayContent);
  }

  createSession(args: {
    workDir?: string;
    permissionMode?: PermissionMode;
    providerId: string;
    model?: string;
    reasoningEffort?: string | null;
  } & ProviderRuntimeControls) {
    const payload = args;
    this.sendRequest('create_session', {
      ...(payload.workDir && { workDir: payload.workDir }),
      ...(payload.permissionMode && { permissionMode: payload.permissionMode }),
      providerId: payload.providerId,
      ...(payload.model && { model: payload.model }),
      ...(payload.reasoningEffort !== undefined && { reasoningEffort: payload.reasoningEffort }),
      ...(payload.sessionMode && { sessionMode: payload.sessionMode }),
      ...(payload.accessMode && { accessMode: payload.accessMode }),
      ...(payload.collaborationMode && { collaborationMode: payload.collaborationMode }),
      ...(payload.approvalPolicy && { approvalPolicy: payload.approvalPolicy }),
      ...(payload.sandboxMode && { sandboxMode: payload.sandboxMode }),
      ...(payload.serviceTier !== undefined && { serviceTier: payload.serviceTier }),
    });
  }

  closeSession(sessionId: string) {
    this.sendRequest('close_session', { sessionId });
  }

  resumeSession(sessionId: string, controls?: ({ permissionMode?: PermissionMode } & ProviderRuntimeControls)) {
    this.sendRequest('resume_session', {
      sessionId,
      ...(controls?.permissionMode && { permissionMode: controls.permissionMode }),
      ...(controls?.sessionMode && { sessionMode: controls.sessionMode }),
      ...(controls?.accessMode && { accessMode: controls.accessMode }),
      ...(controls?.collaborationMode && { collaborationMode: controls.collaborationMode }),
      ...(controls?.approvalPolicy && { approvalPolicy: controls.approvalPolicy }),
      ...(controls?.sandboxMode && { sandboxMode: controls.sandboxMode }),
      ...(controls?.serviceTier !== undefined && { serviceTier: controls.serviceTier }),
    });
  }

  retrySession(sessionId: string) {
    this.sendRequest('retry_session', { sessionId });
  }

  sendInteractiveResponse(
    sessionId: string,
    toolUseId: string,
    response: string
  ): boolean {
    const sent = this.sendRequest('interactive_response', {
      sessionId,
      toolUseId,
      response,
    });
    if (sent) {
      applyLocalInteractiveResponseStart(sessionId, toolUseId, response);
      return true;
    }

    console.error('sendInteractiveResponse failed: WebSocket not open', {
      readyState: this.ws?.readyState,
      sessionId,
      toolUseId,
    });
    return false;
  }

  cancelGeneration(sessionId: string) {
    finalizeInFlightTurn(sessionId);
    this.sendRequest('cancel_generation', { sessionId });
  }

  stopSession(sessionId: string) {
    this.sendRequest('stop_session', { sessionId });
  }

  // NEW - for FEAT-002
  sendMarkAsRead(sessionId: string) {
    this.sendRequest('mark_as_read', { sessionId });
  }

  setPermissionMode(
    sessionId: string,
    mode: PermissionMode | undefined,
    controls?: ProviderRuntimeControls,
  ) {
    this.sendRequest('set_permission_mode', {
      sessionId,
      ...(mode && { mode }),
      ...(controls?.sessionMode && { sessionMode: controls.sessionMode }),
      ...(controls?.accessMode && { accessMode: controls.accessMode }),
      ...(controls?.collaborationMode && { collaborationMode: controls.collaborationMode }),
      ...(controls?.approvalPolicy && { approvalPolicy: controls.approvalPolicy }),
      ...(controls?.sandboxMode && { sandboxMode: controls.sandboxMode }),
      ...(controls?.serviceTier !== undefined && { serviceTier: controls.serviceTier }),
    });
  }

  setModel(sessionId: string, model: string) {
    this.sendRequest('set_model', { sessionId, model });
  }

  setReasoningEffort(sessionId: string, reasoningEffort: string | null) {
    this.sendRequest('set_reasoning_effort', { sessionId, reasoningEffort });
  }

  setServiceTier(sessionId: string, serviceTier: string | null) {
    this.sendRequest('set_service_tier', { sessionId, serviceTier });
  }

  getCommands(sessionId: string) {
    this.sendRequest('get_commands', { sessionId });
  }

  listProviders(callback: (providers: ProviderMeta[]) => void): (() => void) | void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const message = buildClientRequest('list_providers', {});
      this.providersListCallbacks.set(message.requestId, callback);
      this.send(message);
      return () => {
        this.providersListCallbacks.delete(message.requestId);
      };
    } else {
      callback([]);
    }
  }

  refreshProviders(callback: (providers: ProviderMeta[]) => void): (() => void) | void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const message = buildClientRequest('refresh_providers', {});
      this.providersListCallbacks.set(message.requestId, callback);
      this.send(message);
      return () => {
        this.providersListCallbacks.delete(message.requestId);
      };
    } else {
      callback([]);
    }
  }

  checkCliStatus(callback: (results: CliStatusEntry[] | null) => void) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const message = buildClientRequest('check_cli_status', {});
      this.cliStatusCallbacks.set(message.requestId, callback);
      this.send(message);
    } else {
      callback(null);
    }
  }

  createTerminal(args: {
    terminalId: string;
    cwd?: string | null;
    sessionId?: string | null;
    shellKind?: 'default' | 'cmd' | 'powershell' | 'wsl';
    cols?: number;
    rows?: number;
  }): boolean {
    return this.sendRequest('terminal_create', args);
  }

  sendTerminalInput(terminalId: string, data: string) {
    this.sendRequest('terminal_input', { terminalId, data });
  }

  resizeTerminal(terminalId: string, cols: number, rows: number) {
    this.sendRequest('terminal_resize', { terminalId, cols, rows });
  }

  closeTerminal(terminalId: string) {
    this.sendRequest('terminal_close', { terminalId });
  }

  private sendRequest<T extends ClientMessage['type']>(
    type: T,
    payload: Omit<Extract<ClientMessage, { type: T }>, 'type' | 'requestId'>,
  ): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.send(buildClientRequest(type, payload));
    return true;
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private reconnect() {
    if (this.reconnectAttempt >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`WebSocket reconnection failed after ${this.MAX_RECONNECT_ATTEMPTS} attempts. Please refresh the page.`);
      useChatStore.getState().setConnectionStatus('disconnected', this.reconnectAttempt);
      return;
    }

    this.reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10000);

    console.info(`WebSocket reconnecting (attempt ${this.reconnectAttempt}/${this.MAX_RECONNECT_ATTEMPTS}) in ${delay}ms...`);
    useChatStore.getState().setConnectionStatus('reconnecting', this.reconnectAttempt);

    setTimeout(() => {
      if (this.userId) {
        // Reset ws so connect() doesn't skip due to idempotency check
        this.ws = null;
        this.connect(this.userId);
      }
    }, delay);
  }

  disconnect() {
    this.failPendingRequestCallbacks();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    useChatStore.getState().setConnectionStatus('disconnected', 0);
  }

  private failPendingRequestCallbacks() {
    for (const callback of this.providersListCallbacks.values()) {
      callback([]);
    }
    this.providersListCallbacks.clear();

    for (const callback of this.cliStatusCallbacks.values()) {
      callback(null);
    }
    this.cliStatusCallbacks.clear();
  }

  /**
   * Format WebSocket error with actionable guidance
   */
  private formatWebSocketError(event: Event): string {
    // Browser WebSocket errors are opaque for security reasons
    // Provide general guidance based on connection state
    const state = this.ws?.readyState;

    if (state === WebSocket.CONNECTING) {
      return 'Connection failed. Server may be unavailable. Check if the server is running on the correct port.';
    } else if (state === WebSocket.CLOSING || state === WebSocket.CLOSED) {
      return 'Connection lost. Attempting to reconnect...';
    } else {
      return 'Network error. Check your internet connection and try again.';
    }
  }

  /**
   * Format WebSocket close message with context
   */
  private formatCloseMessage(event: CloseEvent): string {
    const { code, reason, wasClean } = event;

    // Standard WebSocket close codes
    switch (code) {
      case 1000:
        return 'Connection closed normally';
      case 1001:
        return 'Server going away (refresh the page to reconnect)';
      case 1006:
        return `Connection lost unexpectedly. ${wasClean ? '' : 'Network interruption detected. '}Attempting to reconnect (attempt ${this.reconnectAttempt + 1}/${this.MAX_RECONNECT_ATTEMPTS})...`;
      case 1008:
        return 'Authentication failed: Invalid or expired token. Please log in again.';
      case 1009:
        return 'Message too large. Try sending smaller messages.';
      case 1011:
        return 'Server error. Please try again later.';
      default:
        return `Connection closed (code ${code}). ${reason || 'No reason provided'}. Attempting to reconnect...`;
    }
  }
}

export const wsClient = new WebSocketClient();
