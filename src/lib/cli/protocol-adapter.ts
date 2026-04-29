import { CliMessage } from './types';
import { processManager } from './process-manager';
import { handleProtocolControlResponse } from './protocol-adapter-control';
import {
  handleProtocolAssistantMessage,
  handleProtocolToolResultMessage,
  handleProtocolUserMessage,
} from './protocol-adapter-conversation';
import { handleProtocolSystemMessage, routeProtocolMessage } from './protocol-adapter-routing';
import {
  buildProtocolStreamReplayEvents,
  type ProtocolStreamState,
} from './protocol-adapter-stream';
import {
  cleanupProtocolSessionState,
  maybeTriggerProtocolAutoTitle,
  type ProtocolTodoSnapshot,
  storeProtocolSessionCommands,
} from './protocol-adapter-session-state';
import {
  handleProtocolProgressMessage,
  handleProtocolResultMessage,
} from './protocol-adapter-turn-lifecycle';
import type { ContentBlock } from '../ws/message-types';
import logger from '../logger';
import type { AppServerMessage, ServerTransportMessage } from '../ws/message-types';
import type { SessionReplayEvent } from '../session-replay-types';

const LIVE_EVENT_VERSION = 1;

export class ProtocolAdapter {
  private sendToUser?: (userId: string, message: ServerTransportMessage) => void;

  /** Sessions that have already triggered auto-title (prevents repeated DB reads) */
  private autoTitleTriggered = new Set<string>();

  /**
   * Per-session contextWindowSize cache.
   * Populated from result message's modelUsage, then attached to future
   * context_usage events emitted from per-call message_start usage.
   */
  private contextWindowSizeCache = new Map<string, number>();

  /**
   * Per-session stream_event state tracking (--include-partial-messages).
   * Tracks active thinking blocks and text streaming status to correctly
   * route content_block_delta events and prevent duplicate messages.
   */
  private streamState = new Map<string, ProtocolStreamState>();

  /** Per-session TodoWrite snapshot for synthesizing rich todo diffs without CLI JSONL. */
  private lastTodoSnapshots = new Map<string, ProtocolTodoSnapshot>();

  /**
   * Set WebSocket send function (dependency injection to avoid circular dependency)
   */
  setSendToUser(fn: (userId: string, message: ServerTransportMessage) => void): void {
    this.sendToUser = fn;
  }

  /**
   * Get the sendToUser function (used by process-manager for Codex dispatch).
   */
  getSendToUser(): ((userId: string, message: ServerTransportMessage) => void) | undefined {
    return this.sendToUser;
  }

  /**
   * Parse stdout JSON Lines
   */
  parseStdout(sessionId: string, userId: string, line: string): void {
    try {
      const msg: CliMessage = JSON.parse(line);
      this.handleMessage(sessionId, userId, msg);
    } catch (err) {
      const error = err as Error;
      logger.error({
        sessionId,
        line: line.substring(0, 100),
        error,
        }, 'CLI message handling error');
    }
  }

  /**
   * Format stdin message
   */
  formatStdin(content: string | ContentBlock[]): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    });
  }

  /**
   * Handle CLI message by type
   */
  private handleMessage(sessionId: string, userId: string, msg: CliMessage): void {
    const startTime = Date.now();

    routeProtocolMessage({
      handlers: {
        system: (nextSessionId, nextUserId, nextMsg) => {
          this.handleSystem(nextSessionId, nextUserId, nextMsg);
        },
        assistant: (nextSessionId, nextUserId, nextMsg) => {
          this.handleAssistant(nextSessionId, nextUserId, nextMsg);
        },
        progress: (nextSessionId, nextUserId, nextMsg) => {
          this.handleProgress(nextSessionId, nextUserId, nextMsg);
        },
        result: (nextSessionId, nextUserId, nextMsg) => {
          this.handleResult(nextSessionId, nextUserId, nextMsg);
        },
        tool_result: (nextSessionId, nextUserId, nextMsg) => {
          this.handleToolResult(nextSessionId, nextUserId, nextMsg);
        },
        control_response: (nextSessionId, nextUserId, nextMsg) => {
          this.handleControlResponse(nextSessionId, nextUserId, nextMsg);
        },
        user: (nextSessionId, nextUserId, nextMsg) => {
          this.handleUserMessage(nextSessionId, nextUserId, nextMsg);
        },
        stream_event: (nextSessionId, nextUserId, nextMsg) => {
          this.handleStreamEvent(nextSessionId, nextUserId, nextMsg);
        },
      },
      msg,
      sessionId,
      userId,
    });

    const duration = Date.now() - startTime;
    if (duration > 20) {
      logger.warn({ sessionId, type: msg.type, duration }, 'Message handling slow');
    }
  }

  /**
   * Handle system messages (init, etc.)
   */
  private handleSystem(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolSystemMessage({
      liveEventVersion: LIVE_EVENT_VERSION,
      msg,
      sendReplayEvent: this.sendReplayEvent.bind(this),
      sessionId,
      updateProcessStatus: (targetSessionId, status) => {
        processManager.updateStatus(targetSessionId, status);
      },
      userId,
    });
  }

  /**
   * Handle assistant messages (Claude responses)
   *
   * With --include-partial-messages always enabled, the CLI emits assistant
   * snapshot messages alongside stream_event deltas.  Text and thinking are
   * handled by stream_event; this method only processes tool_use blocks and
   * collects text for notification preview.
   * processedToolUseIds prevents duplicate tool_call from multiple snapshots.
   */
  private handleAssistant(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolAssistantMessage({
      lastTodoSnapshots: this.lastTodoSnapshots,
      liveEventVersion: LIVE_EVENT_VERSION,
      msg,
      sendAppMessage: this.sendAppMessage.bind(this),
      sendReplayEvent: this.sendReplayEvent.bind(this),
      sessionId,
      streamState: this.streamState,
      userId,
    });
  }

  /**
   * Handle tool_result messages (CLI sends these after tool execution)
   * Note: In --print stream-json mode, the CLI does NOT send type='user' messages
   * with toolUseResult on stdout. The structured toolUseResult only exists in the
   * JSONL session file. The client-side synthesizes toolUseResult from toolParams
   * for tools that support it (TodoWrite, Read/Edit/Write, AskUserQuestion, etc.).
   */
  private handleToolResult(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolToolResultMessage({
      lastTodoSnapshots: this.lastTodoSnapshots,
      liveEventVersion: LIVE_EVENT_VERSION,
      msg,
      sendReplayEvent: this.sendReplayEvent.bind(this),
      sessionId,
      userId,
    });
  }

  /**
   * Handle user messages from CLI stdout.
   * Note: In --print stream-json mode, the CLI does NOT send type='user' messages
   * for tool results on stdout (those only exist in JSONL files). This handler
   * may fire for other user message types (e.g., --replay-user-messages flag).
   */
  private handleUserMessage(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolUserMessage({
      lastTodoSnapshots: this.lastTodoSnapshots,
      liveEventVersion: LIVE_EVENT_VERSION,
      msg,
      sendReplayEvent: this.sendReplayEvent.bind(this),
      sessionId,
      userId,
    });
  }

  /**
   * Handle control_response from CLI (response to SDK-initiated requests like initialize).
   * Extracts commands list and pushes to client via WebSocket.
   */
  private handleControlResponse(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolControlResponse({
      msg,
      sendAppMessage: this.sendAppMessage.bind(this),
      sessionId,
      storeCommands: storeProtocolSessionCommands,
      userId,
    });
  }

  /**
   * Send a control_response to the CLI process via stdin.
   * Used to respond to SDK control_request messages (permission decisions, etc.)
   */
  sendControlResponse(sessionId: string, requestId: string, permissionResult: Record<string, any>): void {
    const sent = processManager.sendControlResponseSuccess(sessionId, requestId, permissionResult);
    if (!sent) {
      logger.warn({ sessionId, requestId }, 'Cannot send control_response');
      return;
    }

    logger.debug({ sessionId, requestId }, 'control_response sent');
  }

  /**
   * Handle progress messages (hooks, typed progress subtypes)
   */
  private handleProgress(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolProgressMessage({
      liveEventVersion: LIVE_EVENT_VERSION,
      msg,
      sendAppMessage: this.sendAppMessage.bind(this),
      sendReplayEvent: this.sendReplayEvent.bind(this),
      sessionId,
      userId,
    });
  }

  /**
   * Handle result messages (task summary)
   */
  private handleResult(sessionId: string, userId: string, msg: CliMessage): void {
    handleProtocolResultMessage({
      contextWindowSizeCache: this.contextWindowSizeCache,
      liveEventVersion: LIVE_EVENT_VERSION,
      maybeAutoGenerateTitle: this.maybeAutoGenerateTitle.bind(this),
      msg,
      sendAppMessage: this.sendAppMessage.bind(this),
      sendReplayEvent: this.sendReplayEvent.bind(this),
      sessionId,
      streamState: this.streamState,
      userId,
    });
  }

  /**
   * Trigger background AI title generation if eligible:
   *  - Session has no custom title (has_custom_title=0)
   *  - User has autoGenerateTitle enabled in settings
   * Fire-and-forget: errors are logged but never thrown.
   */
  maybeAutoGenerateTitle(sessionId: string, userId: string): void {
    maybeTriggerProtocolAutoTitle(
      this.autoTitleTriggered,
      this.sendAppMessage.bind(this),
      sessionId,
      userId,
    );
  }

  // ─── stream_event handlers (--include-partial-messages) ────────────

  /**
   * Handle stream_event messages from the Anthropic streaming API.
   * These provide token-level granularity for text and thinking content.
   */
  private handleStreamEvent(sessionId: string, userId: string, msg: CliMessage): void {
    const replayEvents = buildProtocolStreamReplayEvents({
      contextWindowSizeCache: this.contextWindowSizeCache,
      event: msg.event,
      liveEventVersion: LIVE_EVENT_VERSION,
      sessionId,
      streamState: this.streamState,
    });

    if (replayEvents.length > 0) {
      this.sendReplayEvents(userId, sessionId, replayEvents);
    }
  }

  /**
   * Handle process exit
   */
  handleProcessExit(sessionId: string, userId: string, exitCode: number): void {
    logger.error({ sessionId, userId, exitCode }, 'Handling process exit');

    cleanupProtocolSessionState(
      this.streamState,
      this.contextWindowSizeCache,
      this.lastTodoSnapshots,
      sessionId,
    );

    this.sendAppMessage(userId, {
      type: 'cli_down',
      sessionId,
      exitCode,
      message: `Claude Code Down (exit code: ${exitCode})`,
    });
  }

  /**
   * Send replay event(s) to the WebSocket client.
   */
  private sendReplayEvent(userId: string, sessionId: string, event: SessionReplayEvent): void {
    this.sendReplayEvents(userId, sessionId, [event]);
  }

  private sendReplayEvents(userId: string, sessionId: string, events: SessionReplayEvent[]): void {
    this.sendTransportMessage(userId, {
      type: 'replay_events',
      sessionId,
      events,
    });
  }

  /**
   * Send app/lifecycle messages to the WebSocket client.
   */
  private sendAppMessage(userId: string, message: AppServerMessage): void {
    this.sendTransportMessage(userId, message);
  }

  private sendTransportMessage(userId: string, message: ServerTransportMessage): void {
    if (!this.sendToUser) {
      logger.error({ userId, messageType: message.type }, 'sendToUser not configured');
      return;
    }

    const startTime = Date.now();
    this.sendToUser(userId, message);
    const duration = Date.now() - startTime;

    if (duration > 50) {
      logger.warn({ userId, duration, messageType: message.type }, 'WebSocket send slow');
    }
  }
}

// Singleton instance (globalThis to survive Next.js hot reload and webpack/tsx module boundary)
const PA_KEY = Symbol.for('tessera.protocolAdapter');
const _g = globalThis as unknown as Record<symbol, ProtocolAdapter>;
export const protocolAdapter: ProtocolAdapter = _g[PA_KEY] || (_g[PA_KEY] = new ProtocolAdapter());
