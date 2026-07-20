/**
 * Codex Protocol Parser
 *
 * Pure parser for Codex CLI app-server JSON-RPC 2.0 stdout messages.
 * Codex communicates over stdio using JSON-RPC 2.0: each line is either a
 * notification (no `id`) or a response (`id` + `result` | `error`).
 *
 * Design constraints:
 *  - No direct calls to processManager, WebSocket send, or any I/O.
 *  - Side effects are described via ParsedMessage.sideEffect and executed by the caller.
 *  - Per-session state is maintained internally in Maps keyed by sessionId.
 *
 * Public API:
 *   parseStdout(sessionId: string, line: string): ParsedMessage[]
 *
 * Message mapping table (from plan T-3.1):
 *   item/agentMessage/delta → { type: 'message', role: 'assistant', content: delta.text }
 *   item/started (commandExecution) → { type: 'tool_call', status: 'running' }
 *   item/completed → { type: 'tool_call', status: 'completed' }
 *   turn/completed → { type: 'notification', event: 'completed' } + set_generating sideEffect
 *   turn/started → { type: 'progress_hook', progressType: 'waiting_for_task' } + set_generating
 *   turn_aborted → set_generating false sideEffect only (no WS message)
 *   JSON-RPC error response → { type: 'error' }
 *   Unknown method → null (suppressed)
 *   Malformed line (not valid JSON-RPC) → fallback { type: 'message', content: rawLine }
 */

import os from 'os';
import { randomUUID } from 'crypto';
import type { ParsedMessage } from '../types';
import { CODEX_THREAD_ID_RE } from '../../../validation/path';
import logger from '../../../logger';
import { inferToolCallKindFromToolName, type ToolCallKind } from '@/types/tool-call-kind';
import type { CommandExecutionToolResult } from '@/types/tool-result';
import { buildImageToolResult, isImagePath } from '@/lib/tool-results/tool-image';
import type { AskUserQuestionItem, AskUserQuestionOption } from '@/types/cli-jsonl-schemas';
import { buildCodexRateLimitSnapshot } from '@/lib/status-display/rate-limit-snapshots';
import { buildToolDisplay } from '@/lib/tool-display';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum characters to accumulate in accumulatedText per session turn.
 * accumulatedText is only used for a short preview on turn/completed, so
 * capping it prevents unbounded memory growth for long agent responses.
 */
const MAX_ACCUMULATED_TEXT_LENGTH = 100;

/**
 * Maximum bytes to buffer per outputBuffer item (per commandExecution itemId).
 * Prevents memory exhaustion from very long-running commands with large output.
 */
const MAX_OUTPUT_BUFFER_SIZE = 100 * 1024; // 100KB
const BASH_PROGRESS_EMIT_INTERVAL_MS = 1000;

const DISPLAY_ONLY_CODEX_ITEM_TYPES = new Set([
  'agentMessage',
  'contextCompaction',
  'enteredReviewMode',
  'exitedReviewMode',
  'plan',
  'reasoning',
  'userMessage',
]);

const DISPLAY_ONLY_RAW_RESPONSE_ITEM_TYPES = new Set([
  'compaction',
  'context_compaction',
  'message',
  'reasoning',
]);

// =============================================================================
// JSON-RPC 2.0 Shape Types
// =============================================================================

/**
 * A JSON-RPC 2.0 notification (no `id` field).
 * Used for server-initiated events (turn/started, item/agentMessage/delta, etc.)
 */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
}

/**
 * A JSON-RPC 2.0 response (has `id` field; either result or error).
 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
}

/**
 * A JSON-RPC 2.0 server-initiated request (has both `id` and `method`).
 * Used by Codex app-server for approval requests (item/commandExecution/requestApproval, etc.)
 * These require a corresponding JSON-RPC response from the client.
 */
interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, any>;
}

type JsonRpcMessage = JsonRpcNotification | JsonRpcResponse;

interface CodexRequestUserInputQuestion {
  id?: string;
  header?: string;
  question?: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: AskUserQuestionOption[] | null;
}

const CODEX_MCP_ELICITATION_TOOL_NAME = 'CodexMcpElicitation';
const CODEX_PERMISSIONS_REQUEST_TOOL_NAME = 'CodexPermissionsRequest';

// =============================================================================
// Per-Session State
// =============================================================================

interface SessionState {
  /**
   * Thread ID returned by the Codex app-server `thread/start` response.
   * Used to correlate messages to a specific conversation thread.
   */
  threadId: string | null;

  /**
   * Active turn ID from the most recent `turn/started` notification.
   * Required for `turn/interrupt` requests.
   */
  activeTurnId: string | null;

  /**
   * Maps JSON-RPC request ID → method name for pending requests sent to the
   * Codex app-server. Allows correlating error responses to the correct method.
   */
  pendingRequests: Map<number | string, string>;

  /**
   * Accumulated text for the current agent turn (used to populate notification
   * preview when turn/completed arrives).
   */
  accumulatedText: string;

  /**
   * Accumulated stdout/stderr output per item, keyed by itemId.
   * Populated by item/commandExecution/outputDelta notifications and consumed
   * when item/completed arrives for commandExecution items.
   */
  outputBuffers: Map<string, string>;

  /**
   * The itemId of the reasoning item currently being streamed.
   * Used to detect when a new reasoning block starts (new itemId → new thinking block).
   */
  activeReasoningItemId: string | null;

  /**
   * The thinkingId sent to the Tessera client for the current reasoning block.
   * Generated when the first reasoning delta for a new itemId arrives.
   */
  activeThinkingId: string | null;

  /**
   * Whether this session's current turn has been interrupted via turn/interrupt.
   * When true, incoming delta messages are suppressed until the next turn/completed
   * or turn/started resets the flag.
   */
  interrupted: boolean;

  /**
   * Most recent cumulative thread token usage snapshot from Codex notifications.
   * Used to populate notification.usage on turn completion so the shared
   * Tessera usage pipeline can persist Codex token stats like Claude.
   */
  latestUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    reasoningOutputTokens: number;
    contextWindowSize?: number;
  } | null;

  /**
   * The model identifier last configured for this session (set by the adapter
   * after spawn or model switch). Used to populate the modelUsage breakdown so
   * the Tessera tooltip can label Codex token stats with the actual model name.
   */
  currentModel: string | null;

  /**
   * Per-command state for synthesizing shared bash_progress updates from
   * commandExecution output deltas.
   */
  commandProgress: Map<string, {
    startedAtMs: number;
    lastEmittedAtMs: number;
  }>;

  /**
   * Tracks Codex MCP startup lifecycle by server to avoid duplicate progress rows.
   */
  mcpStartupServers: Map<string, {
    status: 'started' | 'completed' | 'failed';
    startTimestamp: string;
  }>;

  /**
   * Last compact boundary emitted by any Codex compact event shape. Recent
   * duplicates are suppressed because different Codex versions may emit both
   * item-level compaction records and thread-level compacted notifications.
   */
  lastCompactBoundaryAtMs: number;
}

// =============================================================================
// CodexProtocolParser
// =============================================================================

export class CodexProtocolParser {
  /**
   * Per-session state maps. Keyed by sessionId (not threadId) so callers
   * can use the same sessionId they use for WebSocket routing.
   */
  private sessionStates = new Map<string, SessionState>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse a single JSON-RPC 2.0 stdout line from the Codex CLI app-server.
   * Returns an array of ParsedMessage objects (may be empty for suppressed lines).
   *
   * Per plan T-3.1 edge case: if the line is not valid JSON-RPC, fall back to
   * emitting a raw `message` ServerMessage with the line content.
   */
  parseStdout(sessionId: string, line: string): ParsedMessage[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed non-JSON line — emit as raw assistant message per T-3.1 spec
      logger.warn('Codex: non-JSON stdout line, emitting as raw message', {
        sessionId,
        line: trimmed.substring(0, 120),
      });
      return [{
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: trimmed,
        },
      }];
    }

    // Codex app-server may omit the `jsonrpc` field in some messages.
    // Accept any valid JSON object with 'method' or 'id' as JSON-RPC.
    const hasMethod = 'method' in parsed;
    const hasId = 'id' in parsed;

    if (!hasMethod && !hasId) {
      // Valid JSON but not recognizable as JSON-RPC — emit as fallback message
      // so the user can see unexpected output from the CLI.
      logger.warn('Codex: JSON line with neither method nor id, emitting as raw message', {
        sessionId,
        line: trimmed.substring(0, 120),
      });
      return [{
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: trimmed,
        },
      }];
    }

    // Dispatch based on message shape:
    //   - Has 'id' + 'method' → server-initiated request (e.g. requestApproval)
    //   - Has 'id' only        → response to our prior request
    //   - No 'id'              → notification
    if (hasId && hasMethod) {
      return this.handleServerRequest(sessionId, parsed as JsonRpcServerRequest);
    } else if (hasId) {
      return this.handleResponse(sessionId, parsed as JsonRpcResponse);
    } else {
      return this.handleNotification(sessionId, parsed as JsonRpcNotification);
    }
  }

  /**
   * Record a pending outgoing JSON-RPC request so error responses can be
   * correlated to the correct method name.
   * Call this from the adapter when writing requests to Codex stdin.
   */
  trackPendingRequest(sessionId: string, requestId: number | string, method: string): void {
    const state = this.getOrCreateState(sessionId);
    state.pendingRequests.set(requestId, method);
  }

  /**
   * Returns the active turnId for the given session, or null if no turn is active.
   * Used by the adapter to send `turn/interrupt` requests.
   */
  getActiveTurnId(sessionId: string): string | null {
    return this.sessionStates.get(sessionId)?.activeTurnId ?? null;
  }

  /**
   * Store the threadId returned from the `thread/start` response.
   * Called by the adapter after the handshake completes.
   */
  setThreadId(sessionId: string, threadId: string): void {
    const state = this.getOrCreateState(sessionId);
    state.threadId = threadId;
    logger.info('Codex: threadId set', { sessionId, threadId });
  }

  /**
   * Clean up per-session state when the Codex process exits.
   * Returns exit notification messages (mirrors ClaudeCodeProtocolParser pattern).
   */
  handleProcessExit(sessionId: string, exitCode: number): ParsedMessage[] {
    logger.error('Codex: handling process exit', { sessionId, exitCode });
    this.sessionStates.delete(sessionId);

    return [{
      serverMessage: {
        type: 'cli_down',
        sessionId,
        exitCode,
        message: `Codex CLI Down (exit code: ${exitCode})`,
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Internal: JSON-RPC Response Handler
  // ---------------------------------------------------------------------------

  private handleResponse(sessionId: string, msg: JsonRpcResponse): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);

    if (msg.error) {
      // JSON-RPC error response
      const methodName = state.pendingRequests.get(msg.id) ?? 'unknown';
      state.pendingRequests.delete(msg.id);

      logger.error('Codex: JSON-RPC error response', {
        sessionId,
        id: msg.id,
        method: methodName,
        code: msg.error.code,
        message: msg.error.message,
      });

      return [{
        serverMessage: {
          type: 'error',
          sessionId,
          code: String(msg.error.code),
          message: msg.error.message,
        },
      }];
    }

    if (msg.result) {
      const methodName = state.pendingRequests.get(msg.id);
      state.pendingRequests.delete(msg.id);

      logger.debug('Codex: JSON-RPC success response', {
        sessionId,
        id: msg.id,
        method: methodName,
      });

      // thread/start response carries the threadId
      if (methodName === 'thread/start' && msg.result.threadId) {
        this.setThreadId(sessionId, String(msg.result.threadId));
      }

      // turn/interrupt success — mark session as interrupted and stop generating.
      // The Codex server may continue sending a few buffered deltas before the
      // eventual turn/completed notification, so we set the interrupted flag to
      // suppress those trailing messages.
      if (methodName === 'turn/interrupt') {
        state.interrupted = true;
        logger.info('Codex: turn/interrupt acknowledged, suppressing further deltas', { sessionId });
        return [{
          serverMessage: null,
          sideEffect: { type: 'set_generating', value: false },
        }];
      }

      if (methodName === 'account/rateLimits/read') {
        const selectedRateLimit =
          msg.result.rateLimitsByLimitId?.codex ??
          msg.result.rateLimits;
        return [this.buildRateLimitUpdateMessage(selectedRateLimit)];
      }

      // Responses to our own requests generally don't produce WS messages —
      // the server drives conversation state via notifications.
      return [];
    }

    // Unexpected response shape (neither result nor error)
    logger.warn('Codex: JSON-RPC response with neither result nor error', {
      sessionId,
      id: msg.id,
    });
    return [];
  }

  // ---------------------------------------------------------------------------
  // Internal: JSON-RPC Server Request Handler
  // ---------------------------------------------------------------------------

  /**
   * Handles server-initiated JSON-RPC requests (messages that have both `id`
   * and `method`). These require the client to send a corresponding JSON-RPC
   * response via stdin.
   *
   * Currently handles:
   *   item/commandExecution/requestApproval → permission_request interactive_prompt
   *   item/fileChange/requestApproval       → permission_request interactive_prompt
   *   item/tool/requestUserInput            → ask_user_question interactive_prompt
   *   mcpServer/elicitation/request         → ask_user_question or permission_request
   *   item/permissions/requestApproval      → permission_request interactive_prompt
   *   item/tool/call                        → explicit unsupported failure response
   *   account/chatgptAuthTokens/refresh     → explicit unsupported error response
   *   legacy approvals                      → explicit denial response
   */
  private handleServerRequest(sessionId: string, msg: JsonRpcServerRequest): ParsedMessage[] {
    const { method, params = {}, id: requestId } = msg;

    logger.debug('Codex: server request received', { sessionId, method, requestId });

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      return this.handleApprovalRequest(sessionId, requestId, method, params);
    }

    if (method === 'item/tool/requestUserInput') {
      return this.handleRequestUserInput(sessionId, requestId, params);
    }

    if (method === 'mcpServer/elicitation/request') {
      return this.handleMcpServerElicitationRequest(sessionId, requestId, params);
    }

    if (method === 'item/permissions/requestApproval') {
      return this.handlePermissionsRequestApproval(sessionId, requestId, params);
    }

    if (method === 'item/tool/call') {
      return this.handleUnsupportedDynamicToolCall(sessionId, requestId, params);
    }

    if (method === 'account/chatgptAuthTokens/refresh') {
      return this.handleUnsupportedAuthTokenRefresh(sessionId, requestId, params);
    }

    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      return this.handleUnsupportedLegacyApproval(sessionId, requestId, method, params);
    }

    return this.handleUnknownServerRequest(sessionId, requestId, method);
  }

  /**
   * Handles Codex approval requests for command execution and file changes.
   *
   * Emits:
   *   - interactive_prompt (permission_request) so the UI can show the approval dialog
   *   - add_pending_permission_request sideEffect so the approval can be resolved later
   */
  private handleApprovalRequest(
    sessionId: string,
    requestId: number | string,
    method: string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const request = typeof params.item === 'object' && params.item !== null
      ? { ...params, ...params.item }
      : params;
    const toolName: string = method === 'item/commandExecution/requestApproval'
      ? 'Bash'
      : 'Write';
    const toolInput = method === 'item/commandExecution/requestApproval'
      ? {
          command: request.command ?? '',
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(Array.isArray(request.commandActions) ? { commandActions: request.commandActions } : {}),
        }
      : {
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.grantRoot ? { grantRoot: request.grantRoot } : {}),
        };

    const toolUseId = String(requestId);

    logger.info('Codex: approval request received', { sessionId, method, requestId, toolName });

    return [{
      serverMessage: {
        type: 'interactive_prompt',
        sessionId,
        promptType: 'permission_request',
        data: {
          question: `Allow ${toolName}?`,
          toolUseId,
          toolName,
          toolInput,
        },
      },
      sideEffect: {
        type: 'add_pending_permission_request',
        toolUseId,
        requestId: String(requestId),
        toolName,
        input: toolInput,
      },
    }];
  }

  /**
   * Handles Codex request_user_input tool prompts by mapping them onto the
   * existing AskUserQuestion UI contract.
   */
  private handleRequestUserInput(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    if (!Array.isArray(params.questions)) {
      logger.warn('Codex: request_user_input missing questions', { sessionId, requestId });
      return [];
    }

    const questions: AskUserQuestionItem[] = params.questions.map(
      (question: CodexRequestUserInputQuestion, index: number) => ({
        ...(question.id ? { id: question.id } : {}),
        question: question.question ?? '',
        header: question.header ?? `Q${index + 1}`,
        options: Array.isArray(question.options) ? question.options : [],
        multiSelect: false,
        ...(question.isOther !== undefined ? { isOther: question.isOther } : {}),
        ...(question.isSecret !== undefined ? { isSecret: question.isSecret } : {}),
      }),
    );
    const toolUseId = String(requestId);

    logger.info('Codex: request_user_input received', {
      sessionId,
      requestId,
      questionCount: questions.length,
    });

    return [{
      serverMessage: {
        type: 'interactive_prompt',
        sessionId,
        promptType: 'ask_user_question',
        data: {
          question: questions[0]?.question ?? 'Input required',
          toolUseId,
          questions,
          metadata: { source: 'codex_request_user_input' },
        },
      },
      sideEffect: {
        type: 'add_pending_permission_request',
        toolUseId,
        requestId: String(requestId),
        toolName: 'CodexRequestUserInput',
        input: {
          questions,
          metadata: {
            source: 'codex_request_user_input',
            threadId: params.threadId,
            turnId: params.turnId,
            itemId: params.itemId,
          },
        },
      },
    }];
  }

  /**
   * Handles MCP elicitation requests from Codex app-server.
   *
   * Form-mode elicitations are mapped onto the AskUserQuestion UI. URL-mode
   * elicitations need an allow/deny decision because Tessera currently has no
   * first-class browser handoff prompt.
   */
  private handleMcpServerElicitationRequest(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const toolUseId = String(requestId);
    const serverName = typeof params.serverName === 'string' ? params.serverName : 'MCP';
    const message = typeof params.message === 'string' && params.message.trim()
      ? params.message
      : 'MCP server requested input';

    if (params.mode === 'form') {
      const questions = this.buildMcpElicitationQuestions(params);

      logger.info('Codex: MCP elicitation form request received', {
        sessionId,
        requestId,
        serverName,
        questionCount: questions.length,
      });

      if (questions.length > 0) {
        return [{
          serverMessage: {
            type: 'interactive_prompt',
            sessionId,
            promptType: 'ask_user_question',
            data: {
              question: message,
              toolUseId,
              questions,
              metadata: { source: 'codex_mcp_elicitation' },
            },
          },
          sideEffect: {
            type: 'add_pending_permission_request',
            toolUseId,
            requestId: String(requestId),
            toolName: CODEX_MCP_ELICITATION_TOOL_NAME,
            input: {
              ...params,
              questions,
              metadata: { source: 'codex_mcp_elicitation' },
            },
          },
        }];
      }

      return this.buildMcpElicitationPermissionPrompt(
        sessionId,
        requestId,
        {
          ...params,
          questions,
          message,
          serverName,
        },
      );
    }

    if (params.mode === 'url') {
      logger.info('Codex: MCP elicitation URL request received', {
        sessionId,
        requestId,
        serverName,
        url: params.url,
      });

      return this.buildMcpElicitationPermissionPrompt(
        sessionId,
        requestId,
        {
          ...params,
          message,
          serverName,
        },
      );
    }

    logger.warn('Codex: MCP elicitation request has unsupported mode', {
      sessionId,
      requestId,
      mode: params.mode,
    });
    return [];
  }

  /**
   * Handles Codex's expanded permission request protocol. Unlike command/file
   * approval, the response must be a structured permission grant object.
   */
  private handlePermissionsRequestApproval(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const toolUseId = String(requestId);
    const reason = typeof params.reason === 'string' ? params.reason : null;
    const permissions = isRecord(params.permissions) ? params.permissions : {};
    const toolInput = {
      ...(reason ? { reason } : {}),
      permissions,
      ...(params.itemId ? { itemId: String(params.itemId) } : {}),
    };

    logger.info('Codex: permissions request received', {
      sessionId,
      requestId,
      hasReason: !!reason,
      hasNetwork: isRecord(permissions.network),
      hasFileSystem: isRecord(permissions.fileSystem),
    });

    return [{
      serverMessage: {
        type: 'interactive_prompt',
        sessionId,
        promptType: 'permission_request',
        data: {
          question: reason ?? 'Allow requested permissions?',
          toolUseId,
          toolName: 'CodexPermissions',
          toolInput,
          ...(reason ? { decisionReason: reason } : {}),
        },
      },
      sideEffect: {
        type: 'add_pending_permission_request',
        toolUseId,
        requestId: String(requestId),
        toolName: CODEX_PERMISSIONS_REQUEST_TOOL_NAME,
        input: {
          ...params,
          permissions,
        },
      },
    }];
  }

  private handleUnsupportedDynamicToolCall(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const tool = typeof params.tool === 'string' ? params.tool : 'unknown';
    const message = `Codex dynamic tool calls are not supported by Tessera: ${tool}`;

    logger.warn('Codex: dynamic tool call rejected as unsupported', {
      sessionId,
      requestId,
      tool,
    });

    return [{
      serverMessage: {
        type: 'error',
        sessionId,
        code: 'unsupported_codex_dynamic_tool_call',
        message,
      },
      sideEffect: {
        type: 'send_json_rpc_response',
        requestId: String(requestId),
        result: {
          contentItems: [
            {
              type: 'inputText',
              text: message,
            },
          ],
          success: false,
        },
      },
    }];
  }

  private handleUnsupportedAuthTokenRefresh(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const message = 'Codex ChatGPT auth token refresh is not supported by Tessera sessions.';

    logger.warn('Codex: auth token refresh rejected as unsupported', {
      sessionId,
      requestId,
      reason: params.reason,
      previousAccountId: params.previousAccountId,
    });

    return [{
      serverMessage: {
        type: 'error',
        sessionId,
        code: 'unsupported_codex_auth_refresh',
        message,
      },
      sideEffect: {
        type: 'send_json_rpc_error',
        requestId: String(requestId),
        code: -32000,
        message,
      },
    }];
  }

  private handleUnsupportedLegacyApproval(
    sessionId: string,
    requestId: number | string,
    method: string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const message = `Legacy Codex approval request is not supported by this Tessera provider: ${method}`;

    logger.warn('Codex: legacy approval request denied as unsupported', {
      sessionId,
      requestId,
      method,
      callId: params.callId,
    });

    return [{
      serverMessage: {
        type: 'error',
        sessionId,
        code: 'unsupported_codex_legacy_approval',
        message,
      },
      sideEffect: {
        type: 'send_json_rpc_response',
        requestId: String(requestId),
        result: {
          decision: 'denied',
        },
      },
    }];
  }

  private handleUnknownServerRequest(
    sessionId: string,
    requestId: number | string,
    method: string,
  ): ParsedMessage[] {
    const message = `Unsupported Codex server request: ${method}`;

    logger.warn('Codex: unknown server request rejected', { sessionId, method, requestId });

    return [{
      serverMessage: {
        type: 'error',
        sessionId,
        code: 'unsupported_codex_server_request',
        message,
      },
      sideEffect: {
        type: 'send_json_rpc_error',
        requestId: String(requestId),
        code: -32601,
        message,
      },
    }];
  }

  private buildMcpElicitationPermissionPrompt(
    sessionId: string,
    requestId: number | string,
    input: Record<string, any>,
  ): ParsedMessage[] {
    const toolUseId = String(requestId);
    const toolInput = input.mode === 'url'
      ? {
          ...(typeof input.url === 'string' ? { url: input.url } : {}),
          message: input.message,
          serverName: input.serverName,
          ...(typeof input.elicitationId === 'string' ? { elicitationId: input.elicitationId } : {}),
        }
      : {
          message: input.message,
          serverName: input.serverName,
        };

    return [{
      serverMessage: {
        type: 'interactive_prompt',
        sessionId,
        promptType: 'permission_request',
        data: {
          question: input.message ?? 'Allow MCP elicitation?',
          toolUseId,
          toolName: 'MCP Elicitation',
          toolInput,
        },
      },
      sideEffect: {
        type: 'add_pending_permission_request',
        toolUseId,
        requestId: String(requestId),
        toolName: CODEX_MCP_ELICITATION_TOOL_NAME,
        input,
      },
    }];
  }

  private buildMcpElicitationQuestions(params: Record<string, any>): AskUserQuestionItem[] {
    const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const message = typeof params.message === 'string' && params.message.trim()
      ? params.message
      : 'MCP server requested input';

    return Object.entries(properties).map(([propertyName, propertySchema], index) => {
      const schemaObj = isRecord(propertySchema) ? propertySchema : {};
      const title = typeof schemaObj.title === 'string' && schemaObj.title.trim()
        ? schemaObj.title.trim()
        : propertyName;
      const description = typeof schemaObj.description === 'string' && schemaObj.description.trim()
        ? schemaObj.description.trim()
        : '';
      const question = description ? `${message}\n${description}` : message;
      const optionShape = this.buildMcpElicitationQuestionOptions(schemaObj);
      const isSecret = schemaObj.format === 'password';

      return {
        id: propertyName,
        header: this.buildMcpQuestionHeader(title, propertyName, index),
        question,
        options: optionShape.options,
        multiSelect: optionShape.multiSelect,
        custom: optionShape.custom,
        ...(isSecret ? { isSecret: true } : {}),
      };
    });
  }

  private buildMcpElicitationQuestionOptions(schema: Record<string, any>): {
    options: AskUserQuestionOption[];
    multiSelect: boolean;
    custom: boolean;
  } {
    if (schema.type === 'array') {
      const options = this.extractMcpEnumOptions(isRecord(schema.items) ? schema.items : {});
      if (options.length > 0) {
        return { options, multiSelect: true, custom: false };
      }
    }

    const enumOptions = this.extractMcpEnumOptions(schema);
    if (enumOptions.length > 0) {
      return { options: enumOptions, multiSelect: false, custom: false };
    }

    if (schema.type === 'boolean') {
      return {
        options: [
          { label: 'true', description: 'true' },
          { label: 'false', description: 'false' },
        ],
        multiSelect: false,
        custom: false,
      };
    }

    return { options: [], multiSelect: false, custom: true };
  }

  private extractMcpEnumOptions(schema: Record<string, any>): AskUserQuestionOption[] {
    const titledOptions = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;

    if (titledOptions) {
      return titledOptions
        .map((option) => {
          if (!isRecord(option) || typeof option.const !== 'string') return null;
          const title = typeof option.title === 'string' && option.title.trim()
            ? option.title.trim()
            : option.const;
          return {
            label: option.const,
            description: title,
          };
        })
        .filter((option): option is AskUserQuestionOption => option !== null);
    }

    if (Array.isArray(schema.enum)) {
      const enumNames = Array.isArray(schema.enumNames) ? schema.enumNames : [];
      return schema.enum
        .filter((value): value is string => typeof value === 'string')
        .map((value, index) => ({
          label: value,
          description: typeof enumNames[index] === 'string' ? enumNames[index] : value,
        }));
    }

    return [];
  }

  private buildMcpQuestionHeader(title: string, propertyName: string, index: number): string {
    const fallback = propertyName || `Field ${index + 1}`;
    const raw = (title || fallback).trim() || fallback;
    return raw.length > 12 ? raw.slice(0, 12) : raw;
  }

  // ---------------------------------------------------------------------------
  // Internal: JSON-RPC Notification Handler
  // ---------------------------------------------------------------------------

  private handleNotification(sessionId: string, msg: JsonRpcNotification): ParsedMessage[] {
    const { method, params = {} } = msg;

    logger.debug('Codex: notification received', { sessionId, method });

    switch (method) {
      case 'item/agentMessage/delta':
        return this.handleAgentMessageDelta(sessionId, params);

      case 'item/plan/delta':
        return this.handlePlanDelta(sessionId, params);

      case 'item/started':
        return this.handleItemStarted(sessionId, params);

      case 'item/commandExecution/outputDelta':
        return this.handleCommandOutputDelta(sessionId, params);

      case 'item/completed':
        return this.handleItemCompleted(sessionId, params);

      case 'rawResponseItem/completed':
        return this.handleRawResponseItemCompleted(sessionId, params);

      case 'item/reasoning/textDelta':
        return this.handleReasoningTextDelta(sessionId, params);

      case 'item/reasoning/summaryTextDelta':
        return this.handleReasoningSummaryTextDelta(sessionId, params);

      case 'item/reasoning/summaryPartAdded':
        // Marks boundary between summary parts — no WS message needed
        logger.debug('Codex: reasoning summaryPartAdded', { sessionId, itemId: params.itemId });
        return [];

      case 'session_configured':
        return this.handleSessionConfigured(sessionId, params);

      case 'turn/started':
        return this.handleTurnStarted(sessionId, params);

      case 'turn/completed':
        return this.handleTurnCompleted(sessionId, params);

      case 'turn/plan/updated':
        logger.debug('Codex: turn plan updated', {
          sessionId,
          stepCount: Array.isArray(params.plan) ? params.plan.length : 0,
        });
        return [];

      case 'serverRequest/resolved':
        return this.handleServerRequestResolved(sessionId, params);

      case 'turn_aborted':
        return this.handleTurnAborted(sessionId, params);

      case 'account/rateLimits/updated':
        return [this.buildRateLimitUpdateMessage(params.rateLimits)];

      case 'error': {
        // Codex sends turn errors as:
        //   { method: 'error', params: { error: { message, codexErrorInfo, additionalDetails }, willRetry, threadId, turnId } }
        // Older or non-turn errors may use a flat { code, message } shape — keep that as a fallback.
        const errorObj =
          params.error && typeof params.error === 'object' ? (params.error as Record<string, unknown>) : null;
        const codexErrorInfo = typeof errorObj?.codexErrorInfo === 'string' ? errorObj.codexErrorInfo : null;
        const errorMessage = typeof errorObj?.message === 'string' ? errorObj.message : null;
        const additionalDetails = errorObj?.additionalDetails ?? null;
        const willRetry = typeof params.willRetry === 'boolean' ? params.willRetry : null;
        const turnId = typeof params.turnId === 'string' ? params.turnId : null;
        const threadId = typeof params.threadId === 'string' ? params.threadId : null;

        const code =
          codexErrorInfo ?? (params.code != null ? String(params.code) : 'unknown');
        const message =
          errorMessage ?? (typeof params.message === 'string' ? params.message : 'Unknown error');

        // pino's API is (mergingObject, msg) — object first; passing the string
        // first turned the merging object into an unused interpolation arg and
        // dropped every field from the log line.
        // `errorText` rather than `message` because pino-pretty hides keys
        // matching its messageKey from the rendered output.
        logger.error(
          {
            sessionId,
            code,
            errorText: message,
            willRetry,
            threadId,
            turnId,
            additionalDetails,
          },
          'Codex: error notification received',
        );
        return [{
          serverMessage: {
            type: 'error',
            sessionId,
            code,
            message,
          },
        }];
      }

      // =================================================================
      // codex/event/* — Codex-specific enrichment events
      // =================================================================

      // Commentary / plan messages (e.g. "Updated Plan", phase info)
      // NOT emitted as 'message' since item/agentMessage/delta already streams the text.
      case 'codex/event/agent_message':
        return this.handleCodexAgentMessage(sessionId, params);

      // Skip — duplicate of item/agentMessage/delta (triple duplication)
      case 'codex/event/agent_message_content_delta':
      case 'codex/event/agent_message_delta':
        return [];

      // Rich command execution events with parsed_cmd, cwd, stdout
      case 'codex/event/exec_command_begin':
        return this.handleCodexExecCommandBegin(sessionId, params);
      case 'codex/event/exec_command_end':
        return this.handleCodexExecCommandEnd(sessionId, params);

      // Skip — duplicate of item/commandExecution/outputDelta (also base64-encoded)
      case 'codex/event/exec_command_output_delta':
        return [];

      // Token usage with reasoning_output_tokens
      case 'codex/event/token_count':
        return this.handleCodexTokenCount(sessionId, params);

      // Standard protocol token usage (parallel to codex/event/token_count)
      case 'thread/tokenUsage/updated':
        return this.handleThreadTokenUsage(sessionId, params);

      // Turn metadata (context window, collaboration mode)
      case 'codex/event/task_started':
        return this.handleCodexTaskStarted(sessionId, params);

      // MCP server lifecycle
      case 'codex/event/mcp_startup_update':
      case 'codex/event/mcp_startup_complete':
        return this.handleCodexMcpStartup(sessionId, params);

      // Skip — handled by standard item/started and item/completed
      case 'codex/event/item_started':
      case 'codex/event/item_completed':
        return [];

      // Skip — no need to echo user messages back
      case 'codex/event/user_message':
        return [];

      // Thread lifecycle
      case 'thread/started':
        return this.handleThreadStarted(sessionId, params);

      case 'thread/compacted':
        return this.handleThreadCompacted(sessionId, params);

      case 'thread/status/changed':
        logger.debug('Codex: thread lifecycle event', { sessionId, method });
        return [];

      default: {
        // Unknown notification method — suppress (return empty per T-3.1 spec)
        logger.debug('Codex: unknown notification method suppressed', { sessionId, method });
        return [];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Notification: serverRequest/resolved
  // ---------------------------------------------------------------------------

  private handleServerRequestResolved(
    sessionId: string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const requestId = params.requestId;
    if (requestId === undefined || requestId === null) {
      logger.debug('Codex: serverRequest/resolved missing requestId', { sessionId });
      return [];
    }

    return [{
      serverMessage: null,
      sideEffect: {
        type: 'remove_pending_permission_request',
        toolUseId: String(requestId),
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Notification: item/agentMessage/delta
  // ---------------------------------------------------------------------------

  /**
   * Streaming text delta from the Codex agent.
   * Maps to incremental assistant message (same pattern as Claude stream_event).
   */
  private handleAgentMessageDelta(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const delta = params.delta;
    if (!delta) {
      logger.warn('Codex: item/agentMessage/delta missing params.delta', { sessionId });
      return [];
    }

    // delta may be a string or object with .text
    const text: string = typeof delta === 'string'
      ? delta
      : (delta.text ?? delta.content ?? '');

    if (!text) {
      return [];
    }

    const state = this.getOrCreateState(sessionId);

    // Suppress trailing deltas after turn/interrupt was acknowledged.
    // The Codex server may buffer a few more messages before stopping.
    if (state.interrupted) {
      return [];
    }

    // Accumulate for notification preview on turn/completed.
    // Cap at MAX_ACCUMULATED_TEXT_LENGTH — only a short preview is needed.
    if (state.accumulatedText.length < MAX_ACCUMULATED_TEXT_LENGTH) {
      state.accumulatedText = (state.accumulatedText + text).substring(0, MAX_ACCUMULATED_TEXT_LENGTH);
    }

    logger.debug('Codex: agent message delta', { sessionId, textLength: text.length });

    return [{
      serverMessage: {
        type: 'message',
        sessionId,
        role: 'assistant',
        content: text,
        // Stable id per delta; the first delta of a contiguous text run wins on both
        // the client (chunk merge) and the history buffer (||=), so the live message
        // and the flushed assistant_message share one id (translation attach).
        messageId: randomUUID(),
      },
    }];
  }

  /**
   * Streaming text delta from Codex plan mode.
   * Plan deltas are rendered as assistant text so the UI shows the proposed plan
   * even when Codex emits plan-specific items instead of agentMessage deltas.
   */
  private handlePlanDelta(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    return this.handleAgentMessageDelta(sessionId, params);
  }

  // ---------------------------------------------------------------------------
  // Notification: item/started
  // ---------------------------------------------------------------------------

  /**
   * An item (tool / command execution / file change) has started.
   * Mapped to tool_call running when item type is commandExecution.
   */
  private handleItemStarted(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const item = params.item;
    if (!item) {
      logger.warn('Codex: item/started missing params.item', { sessionId });
      return [];
    }

    const itemType: string = item.type ?? '';
    const itemId: string = String(item.id ?? '');
    const timestamp = new Date().toISOString();

    if (itemType === 'commandExecution') {
      const state = this.getOrCreateState(sessionId);
      const toolName = 'Bash';
      const toolKind = inferToolCallKindFromToolName(toolName) ?? 'shell_command';
      const toolParams = this.buildCommandToolParams(item);
      const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
      state.commandProgress.set(itemId, {
        startedAtMs: Date.now(),
        lastEmittedAtMs: 0,
      });

      logger.info('Codex: commandExecution started', { sessionId, toolName, itemId });

      return [{
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
          status: 'running',
          toolUseId: itemId,
          timestamp,
        },
        sideEffect: {
          type: 'add_pending_tool_call',
          toolUseId: itemId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
        },
      }];
    }

    if (itemType === 'fileChange') {
      const toolName = 'Write';
      const toolKind = inferToolCallKindFromToolName(toolName);
      const toolParams = this.buildFileChangeToolParams(item);

      logger.info('Codex: fileChange started', {
        sessionId,
        pathCount: Array.isArray(item.changes) ? item.changes.length : 0,
        itemId,
      });

      return [{
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          status: 'running',
          toolUseId: itemId,
          timestamp,
        },
        sideEffect: {
          type: 'add_pending_tool_call',
          toolUseId: itemId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
        },
      }];
    }

    if (itemType === 'webSearch') {
      const { toolName, toolKind, toolParams } = this.buildWebSearchToolMetadata(item);

      logger.info('Codex: webSearch started', {
        sessionId,
        itemId,
        toolName,
        query: toolParams.query,
        url: toolParams.url,
      });

      return [{
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolName,
          toolKind,
          toolParams,
          status: 'running',
          toolUseId: itemId,
          timestamp,
        },
        sideEffect: {
          type: 'add_pending_tool_call',
          toolUseId: itemId,
          toolName,
          toolKind,
          toolParams,
        },
      }];
    }

    if (itemType === 'dynamicToolCall') {
      const { toolName, toolKind, toolParams } = this.buildDynamicToolMetadata(item);

      logger.info('Codex: dynamicToolCall started', {
        sessionId,
        itemId,
        toolName,
        toolKind,
      });

      return [{
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          status: 'running',
          toolUseId: itemId,
          timestamp,
        },
        sideEffect: {
          type: 'add_pending_tool_call',
          toolUseId: itemId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
        },
      }];
    }

    if (!this.isDisplayOnlyCodexItem(itemType)) {
      return [this.buildGenericCodexItemToolCallMessage(sessionId, item, 'running', timestamp, true)];
    }

    // Display-only item types are handled by dedicated message/reasoning/plan streams.
    logger.debug('Codex: item/started for non-command type suppressed', { sessionId, itemType });
    return [];
  }

  // ---------------------------------------------------------------------------
  // Notification: item/commandExecution/outputDelta
  // ---------------------------------------------------------------------------

  /**
   * Incremental stdout/stderr output from a running command execution.
   * Appends the delta to the output buffer keyed by itemId so the full output
   * is available when item/completed fires.
   * Emits throttled bash_progress updates so long-running commands remain visible.
   */
  private handleCommandOutputDelta(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const itemId: string = String(params.itemId ?? '');
    const delta = params.delta;
    if (!itemId || delta == null) {
      logger.warn('Codex: item/commandExecution/outputDelta missing itemId or delta', {
        sessionId,
        hasItemId: !!itemId,
        hasDelta: delta != null,
      });
      return [];
    }

    const output: string = typeof delta === 'string'
      ? delta
      : (delta.output ?? delta.text ?? delta.content ?? '');

    if (!output) {
      return [];
    }

    const state = this.getOrCreateState(sessionId);
    if (state.interrupted) {
      return [];
    }
    const existing = state.outputBuffers.get(itemId) ?? '';

    // Cap the per-item output buffer at MAX_OUTPUT_BUFFER_SIZE to prevent OOM
    // for commands that produce very large stdout/stderr streams.
    if (existing.length < MAX_OUTPUT_BUFFER_SIZE) {
      const combined = existing + output;
      state.outputBuffers.set(itemId, combined.length > MAX_OUTPUT_BUFFER_SIZE
        ? combined.substring(0, MAX_OUTPUT_BUFFER_SIZE)
        : combined);
    }

    const totalLength = (state.outputBuffers.get(itemId) ?? '').length;
    logger.debug('Codex: commandExecution outputDelta appended', {
      sessionId,
      itemId,
      deltaLength: output.length,
      totalLength,
      capped: totalLength >= MAX_OUTPUT_BUFFER_SIZE,
    });

    const progress = state.commandProgress.get(itemId);
    if (!progress) {
      return [];
    }

    const now = Date.now();
    if (now - progress.lastEmittedAtMs < BASH_PROGRESS_EMIT_INTERVAL_MS) {
      return [];
    }

    progress.lastEmittedAtMs = now;
    return [this.buildBashProgressMessage(sessionId, itemId, progress.startedAtMs)];
  }

  // ---------------------------------------------------------------------------
  // Notification: item/completed
  // ---------------------------------------------------------------------------

  /**
   * An item has completed execution.
   * Mapped to tool_call completed.
   */
  private handleItemCompleted(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const item = params.item;
    if (!item) {
      logger.warn('Codex: item/completed missing params.item', { sessionId });
      return [];
    }

    const itemType: string = item.type ?? '';
    const itemId: string = String(item.id ?? '');
    const timestamp = new Date().toISOString();

    if (itemType === 'commandExecution' || itemType === 'fileChange') {
      const state = this.getOrCreateState(sessionId);
      const toolName = itemType === 'commandExecution'
        ? 'Bash'
        : 'Write';
      const toolKind = inferToolCallKindFromToolName(toolName)
        ?? (itemType === 'commandExecution' ? 'shell_command' : 'file_write');
      const toolParams = itemType === 'commandExecution'
        ? this.buildCommandToolParams(item)
        : this.buildFileChangeToolParams(item);
      const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);

      // For commandExecution: prefer accumulated delta output over item.output,
      // since the CLI streams output incrementally via outputDelta notifications.
      let output: string | undefined;
      let toolUseResult: CommandExecutionToolResult | undefined;
      const messages: ParsedMessage[] = [];
      if (itemType === 'commandExecution') {
        const buffered = state.outputBuffers.get(itemId);
        if (buffered != null && buffered.length > 0) {
          output = buffered;
          state.outputBuffers.delete(itemId);
        } else {
          // Fall back to item.output if no buffer was accumulated
          output = typeof item.output === 'string'
            ? item.output
            : item.output != null ? JSON.stringify(item.output) : undefined;
          state.outputBuffers.delete(itemId);
        }
        toolUseResult = this.buildCommandToolResult(item, output);
        const progress = state.commandProgress.get(itemId);
        if (progress && output) {
          messages.push(this.buildBashProgressMessage(sessionId, itemId, progress.startedAtMs, output));
        }
        state.commandProgress.delete(itemId);
      } else {
        output = typeof item.output === 'string'
          ? item.output
          : item.output != null ? JSON.stringify(item.output) : undefined;
        if (!output && Array.isArray(item.changes) && item.changes.length > 0) {
          output = item.changes
            .map((change: Record<string, any>) => typeof change.diff === 'string' ? change.diff : '')
            .filter(Boolean)
            .join('\n');
        }
      }

      const isError = itemType === 'commandExecution'
        ? item.exitCode != null && item.exitCode !== 0
        : item.status === 'failed' || item.status === 'declined';

      logger.info('Codex: item completed', {
        sessionId,
        itemType,
        toolName,
        itemId,
        isError,
        outputLength: output?.length ?? 0,
      });

      messages.push({
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolUseId: itemId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
          status: isError ? 'error' : 'completed',
          output: isError ? undefined : output,
          error: isError ? output : undefined,
          ...(toolUseResult && !isError ? { toolUseResult } : {}),
          timestamp,
        },
        sideEffect: { type: 'remove_pending_tool_call', toolUseId: itemId },
      });

      return messages;
    }

    if (itemType === 'webSearch') {
      const { toolName, toolKind, toolParams } = this.buildWebSearchToolMetadata(item);

      logger.info('Codex: webSearch completed', {
        sessionId,
        itemId,
        toolName,
        query: toolParams.query,
        url: toolParams.url,
      });

      return [{
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolUseId: itemId,
          toolName,
          toolKind,
          toolParams,
          status: 'completed',
          timestamp,
        },
        sideEffect: { type: 'remove_pending_tool_call', toolUseId: itemId },
      }];
    }

    if (itemType === 'dynamicToolCall') {
      const { toolName, toolKind, toolParams } = this.buildDynamicToolMetadata(item);
      const output = this.buildDynamicToolOutput(item);
      const isError = this.isDynamicToolCallError(item);

      logger.info('Codex: dynamicToolCall completed', {
        sessionId,
        itemId,
        toolName,
        toolKind,
        isError,
      });

      return [{
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolUseId: itemId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          status: isError ? 'error' : 'completed',
          output: isError ? undefined : output,
          error: isError ? output || 'Dynamic tool call failed' : undefined,
          timestamp,
        },
        sideEffect: { type: 'remove_pending_tool_call', toolUseId: itemId },
      }];
    }

    if (itemType === 'contextCompaction') {
      return this.buildCompactBoundaryMessages(sessionId, {
        source: itemType,
        itemId,
        threadId: params.threadId ?? item.threadId,
        turnId: params.turnId ?? item.turnId,
      });
    }

    if (!this.isDisplayOnlyCodexItem(itemType)) {
      const status = this.normalizeCodexItemStatus(item.status, 'completed');
      return [this.buildGenericCodexItemToolCallMessage(sessionId, item, status, timestamp, false)];
    }

    // Display-only item types are handled by dedicated message/reasoning/plan streams.
    logger.debug('Codex: item/completed for non-command type suppressed', { sessionId, itemType });
    return [];
  }

  private handleRawResponseItemCompleted(
    sessionId: string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const item = params.item;
    if (!isRecord(item)) {
      logger.warn('Codex: rawResponseItem/completed missing params.item', { sessionId });
      return [];
    }

    const itemType = typeof item.type === 'string' && item.type.trim()
      ? item.type.trim()
      : 'unknown';
    if (itemType === 'compaction' || itemType === 'context_compaction') {
      return this.buildCompactBoundaryMessages(sessionId, {
        source: itemType,
        threadId: params.threadId ?? item.threadId,
        turnId: params.turnId ?? item.turnId,
      });
    }

    if (DISPLAY_ONLY_RAW_RESPONSE_ITEM_TYPES.has(itemType)) {
      logger.debug('Codex: rawResponseItem/completed display-only item suppressed', { sessionId, itemType });
      return [];
    }

    const timestamp = new Date().toISOString();
    const status = this.normalizeCodexItemStatus(item.status, 'completed');
    const message = itemType === 'web_search_call'
      ? this.buildRawWebSearchToolCallMessage(sessionId, item, status, timestamp)
      : this.buildRawGenericToolCallMessage(sessionId, item, status, timestamp);

    logger.info('Codex: raw response item mapped to tool_call', {
      sessionId,
      itemType,
      toolName: message.serverMessage?.type === 'tool_call' ? message.serverMessage.toolName : undefined,
      status,
    });

    return [message];
  }

  private buildCommandToolParams(item: Record<string, any>): Record<string, any> {
    return {
      command: item.command ?? '',
      ...(item.cwd ? { cwd: item.cwd } : {}),
      ...(Array.isArray(item.commandActions) ? { commandActions: item.commandActions } : {}),
      ...(item.processId ? { processId: item.processId } : {}),
    };
  }

  private buildFileChangeToolParams(item: Record<string, any>): Record<string, any> {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((change: Record<string, any>) => typeof change.path === 'string' ? change.path : '')
      .filter(Boolean);

    return {
      ...(paths[0] ? { file_path: paths[0] } : {}),
      ...(paths.length > 1 ? { file_paths: paths } : {}),
      ...(changes.length > 0 ? { changes } : {}),
    };
  }

  private buildWebSearchToolMetadata(item: Record<string, any>): {
    toolName: string;
    toolKind: ToolCallKind;
    toolParams: Record<string, any>;
  } {
    const action = isRecord(item.action) ? item.action : undefined;
    const actionType = typeof action?.type === 'string' ? action.type : undefined;
    const query = this.extractWebSearchQuery(item, action);
    const url = this.extractWebSearchUrl(action);
    const pattern = typeof action?.pattern === 'string' && action.pattern.trim()
      ? action.pattern.trim()
      : undefined;
    const toolKind: ToolCallKind =
      actionType === 'openPage' ||
      actionType === 'open_page' ||
      actionType === 'findInPage' ||
      actionType === 'find_in_page'
        ? 'web_fetch'
        : 'web_search';
    const toolName = toolKind === 'web_fetch' ? 'WebFetch' : 'WebSearch';

    return {
      toolName,
      toolKind,
      toolParams: {
        ...(query ? { query } : {}),
        ...(url ? { url } : {}),
        ...(pattern ? { pattern } : {}),
        ...(actionType ? { actionType } : {}),
        ...(action ? { action } : {}),
      },
    };
  }

  private buildRawWebSearchToolCallMessage(
    sessionId: string,
    item: Record<string, any>,
    status: 'running' | 'completed' | 'error',
    timestamp: string,
  ): ParsedMessage {
    const { toolName, toolKind, toolParams } = this.buildWebSearchToolMetadata({
      type: 'webSearch',
      action: item.action,
    });

    return {
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolName,
        toolKind,
        toolParams: {
          responseItemType: 'web_search_call',
          status: item.status,
          ...toolParams,
        },
        status,
        timestamp,
      },
    };
  }

  private buildRawGenericToolCallMessage(
    sessionId: string,
    item: Record<string, any>,
    status: 'running' | 'completed' | 'error',
    timestamp: string,
  ): ParsedMessage {
    const itemType = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'unknown';
    const toolName = `CodexRaw ${itemType}`;
    const output = this.buildRawResponseItemOutput(item);

    return {
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolName,
        toolParams: this.extractRawResponseItemParams(item),
        status,
        output: status === 'error' ? undefined : output,
        error: status === 'error' ? output || `${toolName} failed` : undefined,
        timestamp,
      },
    };
  }

  private extractRawResponseItemParams(item: Record<string, any>): Record<string, any> {
    const params: Record<string, any> = {
      responseItemType: typeof item.type === 'string' ? item.type : 'unknown',
    };

    for (const [key, value] of Object.entries(item)) {
      if (
        key === 'type' ||
        key === 'encrypted_content' ||
        key === 'output' ||
        key === 'result' ||
        key === 'tools'
      ) {
        continue;
      }

      params[key] = value;
    }

    return params;
  }

  private buildRawResponseItemOutput(item: Record<string, any>): string | undefined {
    if (item.output !== undefined && item.output !== null) {
      return this.stringifyCodexItemValue(item.output);
    }

    if (item.result !== undefined && item.result !== null) {
      return this.stringifyCodexItemValue(item.result);
    }

    if (Array.isArray(item.tools)) {
      return this.stringifyCodexItemValue(item.tools);
    }

    return undefined;
  }

  private extractWebSearchQuery(
    item: Record<string, any>,
    action: Record<string, any> | undefined,
  ): string | undefined {
    if (typeof item.query === 'string' && item.query.trim()) {
      return item.query.trim();
    }
    if (typeof action?.query === 'string' && action.query.trim()) {
      return action.query.trim();
    }
    if (Array.isArray(action?.queries)) {
      const queries = action.queries
        .filter((query: unknown): query is string => typeof query === 'string' && query.trim().length > 0)
        .map((query: string) => query.trim());
      if (queries.length > 0) return queries.join(' | ');
    }
    return undefined;
  }

  private extractWebSearchUrl(action: Record<string, any> | undefined): string | undefined {
    return typeof action?.url === 'string' && action.url.trim()
      ? action.url.trim()
      : undefined;
  }

  private buildDynamicToolMetadata(item: Record<string, any>): {
    toolName: string;
    toolKind?: ToolCallKind;
    toolParams: Record<string, any>;
  } {
    const namespace = typeof item.namespace === 'string' && item.namespace.trim()
      ? item.namespace.trim()
      : undefined;
    const tool = typeof item.tool === 'string' && item.tool.trim()
      ? item.tool.trim()
      : 'Tool';
    const toolName = namespace ? `${namespace}.${tool}` : tool;
    const args = isRecord(item.arguments) ? item.arguments : undefined;
    const toolKind = this.inferDynamicToolKind(namespace, tool, args);
    const webRunSummary = this.isWebRunDynamicTool(namespace, tool)
      ? this.extractWebRunSummary(args)
      : {};

    return {
      toolName,
      ...(toolKind !== undefined ? { toolKind } : {}),
      toolParams: {
        ...(namespace ? { namespace } : {}),
        tool,
        ...(args ? args : item.arguments !== undefined ? { arguments: item.arguments } : {}),
        ...webRunSummary,
      },
    };
  }

  private inferDynamicToolKind(
    namespace: string | undefined,
    tool: string,
    args: Record<string, any> | undefined,
  ): ToolCallKind | undefined {
    if (!this.isWebRunDynamicTool(namespace, tool)) {
      return inferToolCallKindFromToolName(tool);
    }

    if (!args) return 'web_search';
    if (
      Array.isArray(args.open) ||
      Array.isArray(args.click) ||
      Array.isArray(args.find) ||
      Array.isArray(args.screenshot)
    ) {
      return 'web_fetch';
    }

    return 'web_search';
  }

  private isWebRunDynamicTool(namespace: string | undefined, tool: string): boolean {
    const normalizedNamespace = namespace?.toLowerCase();
    const normalizedTool = tool.toLowerCase();
    return (normalizedNamespace === 'web' && normalizedTool === 'run') || normalizedTool === 'web.run';
  }

  private extractWebRunSummary(args: Record<string, any> | undefined): Record<string, string> {
    if (!args) return {};

    const query = this.extractWebRunQuery(args);
    const url = this.extractWebRunUrl(args);

    return {
      ...(query ? { query } : {}),
      ...(url ? { url } : {}),
    };
  }

  private extractWebRunQuery(args: Record<string, any>): string | undefined {
    const querySources = [
      ...this.extractQueryList(args.search_query),
      ...this.extractQueryList(args.image_query),
    ];
    if (querySources.length > 0) return querySources.join(' | ');

    const weatherLocation = this.extractFirstStringFromRecordList(args.weather, 'location');
    if (weatherLocation) return `weather: ${weatherLocation}`;

    const financeTicker = this.extractFirstStringFromRecordList(args.finance, 'ticker');
    if (financeTicker) return `finance: ${financeTicker}`;

    const sportsLeague = this.extractFirstStringFromRecordList(args.sports, 'league');
    if (sportsLeague) return `sports: ${sportsLeague}`;

    return undefined;
  }

  private extractQueryList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const query = typeof entry.q === 'string' && entry.q.trim() ? entry.q.trim() : undefined;
      return query ? [query] : [];
    });
  }

  private extractFirstStringFromRecordList(value: unknown, key: string): string | undefined {
    if (!Array.isArray(value)) return undefined;
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const item = entry[key];
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
    return undefined;
  }

  private extractWebRunUrl(args: Record<string, any>): string | undefined {
    const openRef = this.extractFirstStringFromRecordList(args.open, 'ref_id');
    if (openRef && /^https?:\/\//i.test(openRef)) return openRef;

    const findRef = this.extractFirstStringFromRecordList(args.find, 'ref_id');
    if (findRef && /^https?:\/\//i.test(findRef)) return findRef;

    return undefined;
  }

  private buildDynamicToolOutput(item: Record<string, any>): string | undefined {
    if (!Array.isArray(item.contentItems)) return undefined;

    const text = item.contentItems
      .flatMap((contentItem: unknown) => {
        if (!isRecord(contentItem)) return [];
        return typeof contentItem.text === 'string' && contentItem.text.trim()
          ? [contentItem.text.trim()]
          : [];
      })
      .join('\n');

    return text || undefined;
  }

  private isDynamicToolCallError(item: Record<string, any>): boolean {
    return item.success === false || item.status === 'failed';
  }

  private isDisplayOnlyCodexItem(itemType: string): boolean {
    return DISPLAY_ONLY_CODEX_ITEM_TYPES.has(itemType);
  }

  private buildGenericCodexItemToolCallMessage(
    sessionId: string,
    item: Record<string, any>,
    status: 'running' | 'completed' | 'error',
    timestamp: string,
    addPending: boolean,
  ): ParsedMessage {
    const itemId = String(item.id ?? '');
    const { toolName, toolParams } = this.buildGenericCodexItemMetadata(item);
    const output = status === 'running' ? undefined : this.buildGenericCodexItemOutput(item);

    // `view_image` (imageView) injects a local file into context with no image
    // bytes in the result — render it inline by serving the file at `path`.
    const isImageView = toolParams.itemType === 'imageView' || toolName === 'ViewImage';
    const toolKind: ToolCallKind | undefined = isImageView ? 'file_read' : undefined;
    const imageToolUseResult = isImageView && status === 'completed' && itemId && isImagePath(toolParams.path)
      ? buildImageToolResult(sessionId, itemId)
      : undefined;

    logger.info('Codex: generic item mapped to tool_call', {
      sessionId,
      itemId,
      itemType: item.type,
      toolName,
      status,
    });

    return {
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolUseId: itemId,
        toolName,
        ...(toolKind !== undefined ? { toolKind } : {}),
        toolParams,
        status,
        output: status === 'error' ? undefined : output,
        error: status === 'error' ? output || `${toolName} failed` : undefined,
        ...(imageToolUseResult !== undefined ? { toolUseResult: imageToolUseResult } : {}),
        timestamp,
      },
      sideEffect: addPending
        ? {
            type: 'add_pending_tool_call',
            toolUseId: itemId,
            toolName,
            toolParams,
          }
        : { type: 'remove_pending_tool_call', toolUseId: itemId },
    };
  }

  private buildGenericCodexItemMetadata(item: Record<string, any>): {
    toolName: string;
    toolParams: Record<string, any>;
  } {
    const itemType = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'unknown';
    const params = this.extractGenericCodexItemParams(item);

    switch (itemType) {
      case 'mcpToolCall': {
        const server = typeof item.server === 'string' && item.server.trim() ? item.server.trim() : undefined;
        const tool = typeof item.tool === 'string' && item.tool.trim() ? item.tool.trim() : 'tool';
        return {
          toolName: server ? `MCP ${server}.${tool}` : `MCP ${tool}`,
          toolParams: params,
        };
      }
      case 'collabAgentToolCall': {
        const tool = typeof item.tool === 'string' && item.tool.trim() ? item.tool.trim() : 'tool';
        return {
          toolName: `CodexCollab ${tool}`,
          toolParams: params,
        };
      }
      case 'hookPrompt':
        return { toolName: 'HookPrompt', toolParams: params };
      case 'imageGeneration':
        return { toolName: 'ImageGeneration', toolParams: params };
      case 'imageView':
        return { toolName: 'ViewImage', toolParams: params };
      default:
        return { toolName: `Codex ${itemType}`, toolParams: params };
    }
  }

  private extractGenericCodexItemParams(item: Record<string, any>): Record<string, any> {
    const params: Record<string, any> = {
      itemType: typeof item.type === 'string' ? item.type : 'unknown',
    };

    for (const [key, value] of Object.entries(item)) {
      if (
        key === 'id' ||
        key === 'type' ||
        key === 'aggregatedOutput' ||
        key === 'contentItems' ||
        key === 'error' ||
        key === 'result'
      ) {
        continue;
      }

      params[key] = value;
    }

    return params;
  }

  private buildGenericCodexItemOutput(item: Record<string, any>): string | undefined {
    if (isRecord(item.error)) {
      const message = typeof item.error.message === 'string' && item.error.message.trim()
        ? item.error.message.trim()
        : undefined;
      if (message) return message;
    }

    if (item.result !== undefined && item.result !== null) {
      return this.stringifyCodexItemValue(item.result);
    }

    const dynamicOutput = this.buildDynamicToolOutput(item);
    if (dynamicOutput) return dynamicOutput;

    if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
      return this.truncateCodexItemText(item.aggregatedOutput.trim());
    }

    if (typeof item.savedPath === 'string' && item.savedPath.trim()) {
      return `Saved: ${item.savedPath.trim()}`;
    }

    if (typeof item.revisedPrompt === 'string' && item.revisedPrompt.trim()) {
      return item.revisedPrompt.trim();
    }

    return undefined;
  }

  private stringifyCodexItemValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return this.truncateCodexItemText(value);
    }

    try {
      return this.truncateCodexItemText(JSON.stringify(value));
    } catch {
      return this.truncateCodexItemText(String(value));
    }
  }

  private truncateCodexItemText(value: string): string {
    if (value.length <= MAX_OUTPUT_BUFFER_SIZE) return value;
    return `${value.slice(0, MAX_OUTPUT_BUFFER_SIZE)}\n[... truncated ...]`;
  }

  private normalizeCodexItemStatus(
    status: unknown,
    fallback: 'running' | 'completed' | 'error',
  ): 'running' | 'completed' | 'error' {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'declined':
      case 'failed':
        return 'error';
      case 'inProgress':
        return 'running';
      default:
        return fallback;
    }
  }

  private buildCommandToolResult(
    item: Record<string, any>,
    output: string | undefined,
  ): CommandExecutionToolResult {
    return {
      kind: 'command_execution',
      stdout: output ?? '',
      stderr: '',
      interrupted: item.status === 'declined',
    };
  }

  // ---------------------------------------------------------------------------
  // Notification: turn/started
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Notification: session_configured
  // ---------------------------------------------------------------------------

  /**
   * Emitted by the Codex app-server when a session has been configured.
   * Stores provider-specific resume state surfaced by the CLI.
   *
   * Resume history rendering is handled by Tessera's own canonical JSONL, so
   * params.initial_messages is intentionally ignored here.
   */
  private handleSessionConfigured(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const rawSessionId = params.session_id;

    if (typeof rawSessionId !== 'string' || !rawSessionId) {
      logger.warn('Codex: session_configured missing params.session_id', { sessionId });
      return [];
    }

    // Validate threadId: alphanumeric, underscore, hyphen, 1–128 chars
    if (!CODEX_THREAD_ID_RE.test(rawSessionId)) {
      logger.warn('Codex: session_configured invalid session_id format', {
        sessionId,
        rawSessionId,
      });
      return [];
    }

    const threadId = rawSessionId;

    logger.info('Codex: session_configured received', { sessionId, threadId });

    return [{
      serverMessage: null,
      sideEffect: {
        type: 'update_provider_state',
        providerState: { threadId },
      },
    }];
  }

  /**
   * The Codex agent has started a new turn (processing user input).
   * Emits waiting_for_task metadata plus set_generating sideEffect.
   * The visible UI state is handled by the shared bottom waiting indicator.
   */
  private handleTurnStarted(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    state.accumulatedText = '';
    state.interrupted = false;

    // Extract turnId from params.turn.id (required for turn/interrupt)
    const turnId = params.turn?.id ?? null;
    state.activeTurnId = turnId;

    logger.info('Codex: turn started', { sessionId, turnId });

    return [{
      serverMessage: {
        type: 'progress_hook',
        sessionId,
        hookEvent: 'waiting_for_task',
        progressType: 'waiting_for_task',
        data: {
          type: 'waiting_for_task',
          taskDescription: 'Generating response',
          taskType: 'local_agent',
        },
        timestamp: new Date().toISOString(),
      },
    }, {
      serverMessage: null,
      sideEffect: { type: 'set_generating', value: true },
    }];
  }

  // ---------------------------------------------------------------------------
  // Notification: turn/completed
  // ---------------------------------------------------------------------------

  /**
   * The Codex agent has finished its turn.
   * Per plan T-3.1: emits notification completed + set_generating false sideEffect.
   */
  private handleTurnCompleted(sessionId: string, _params: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const preview = state.accumulatedText.substring(0, 50);
    const hasMore = state.accumulatedText.length > 50;
    const latestUsage = state.latestUsage;
    this.resetTurnState(state);

    const messages: ParsedMessage[] = [];

    // Finalize any active thinking block before emitting turn/completed
    if (state.activeThinkingId) {
      messages.push({
        serverMessage: {
          type: 'thinking_update',
          sessionId,
          thinkingId: state.activeThinkingId,
          contentDelta: '',
          status: 'completed',
          timestamp: new Date().toISOString(),
        },
      });
      state.activeThinkingId = null;
      state.activeReasoningItemId = null;
    }

    logger.info('Codex: turn completed', { sessionId, preview });

    messages.push(
      {
        serverMessage: {
          type: 'notification',
          sessionId,
          event: 'completed',
          message: 'Task completed.',
          preview: preview + (hasMore ? '...' : ''),
          usage: latestUsage ? {
            inputTokens: latestUsage.inputTokens,
            outputTokens: latestUsage.outputTokens,
            cacheReadTokens: latestUsage.cacheReadTokens,
            cacheCreationTokens: 0,
            durationMs: 0,
            durationApiMs: 0,
            numTurns: 0,
            costUsd: 0,
            contextWindowSize: latestUsage.contextWindowSize,
            modelUsage: state.currentModel ? [{
              model: state.currentModel,
              inputTokens: latestUsage.inputTokens,
              outputTokens: latestUsage.outputTokens,
              cacheReadInputTokens: latestUsage.cacheReadTokens,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0,
              contextWindow: latestUsage.contextWindowSize,
            }] : undefined,
          } : undefined,
        },
      },
      {
        serverMessage: null,
        sideEffect: { type: 'set_generating', value: false },
      },
      {
        serverMessage: null,
        sideEffect: { type: 'auto_generate_title' },
      },
    );

    return messages;
  }

  // ---------------------------------------------------------------------------
  // Notification: turn_aborted
  // ---------------------------------------------------------------------------

  /**
   * The Codex agent has aborted the current turn (e.g. due to an error or
   * external cancellation).
   * Per plan T-4.2: emits no WS message, only set_generating false sideEffect.
   * Resets interrupted/accumulatedText state like turn/completed.
   */
  private handleTurnAborted(sessionId: string, _params: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    this.resetTurnState(state);

    logger.info('Codex: turn aborted', { sessionId });

    return [{
      serverMessage: {
        type: 'system',
        sessionId,
        message: 'Generation interrupted before completion.',
        severity: 'warning',
        subtype: 'turn_aborted',
        timestamp: new Date().toISOString(),
      },
    }, {
      serverMessage: null,
      sideEffect: { type: 'set_generating', value: false },
    }];
  }

  // ---------------------------------------------------------------------------
  // Notification: thread/started
  // ---------------------------------------------------------------------------

  /**
   * Emitted by the Codex app-server after a thread/start or thread/resume
   * response. Contains params.thread.id (threadId).
   *
   * Emits an update_provider_state sideEffect so the process manager can
   * persist provider-specific resume state.
   */
  private handleThreadStarted(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const thread = params.thread;
    if (!thread) {
      logger.debug('Codex: thread/started missing params.thread', { sessionId });
      return [];
    }

    const rawThreadId = thread.id;

    if (typeof rawThreadId !== 'string' || !rawThreadId) {
      logger.debug('Codex: thread/started missing thread.id', { sessionId });
      return [];
    }

    // Validate threadId format
    if (!CODEX_THREAD_ID_RE.test(rawThreadId)) {
      logger.warn('Codex: thread/started invalid thread.id format', { sessionId, rawThreadId });
      return [];
    }

    logger.info('Codex: thread/started — emitting update_provider_state', {
      sessionId,
      threadId: rawThreadId,
    });

    return [{
      serverMessage: null,
      sideEffect: {
        type: 'update_provider_state',
        providerState: { threadId: rawThreadId },
      },
    }];
  }

  private handleThreadCompacted(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    return this.buildCompactBoundaryMessages(sessionId, {
      source: 'thread/compacted',
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }

  private buildCompactBoundaryMessages(
    sessionId: string,
    metadata: {
      itemId?: unknown;
      source: string;
      threadId?: unknown;
      turnId?: unknown;
    },
  ): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const now = Date.now();
    if (now - state.lastCompactBoundaryAtMs < 5_000) {
      logger.debug('Codex: duplicate compact boundary suppressed', {
        sessionId,
        source: metadata.source,
      });
      return [];
    }
    state.lastCompactBoundaryAtMs = now;

    const threadId = typeof metadata.threadId === 'string' && metadata.threadId.trim()
      ? metadata.threadId.trim()
      : state.threadId;
    const turnId = typeof metadata.turnId === 'string' && metadata.turnId.trim()
      ? metadata.turnId.trim()
      : undefined;
    const itemId = typeof metadata.itemId === 'string' && metadata.itemId.trim()
      ? metadata.itemId.trim()
      : undefined;

    logger.info('Codex: thread compacted', {
      sessionId,
      threadId,
      turnId,
      source: metadata.source,
    });

    return [{
      serverMessage: {
        type: 'system',
        sessionId,
        message: 'Context compacted',
        severity: 'info',
        subtype: 'compact_boundary',
        metadata: {
          compactMetadata: {
            trigger: 'manual',
            provider: 'codex',
            source: metadata.source,
            ...(threadId ? { threadId } : {}),
            ...(turnId ? { turnId } : {}),
            ...(itemId ? { itemId } : {}),
          },
        },
        timestamp: new Date().toISOString(),
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Notification: item/reasoning/textDelta
  // ---------------------------------------------------------------------------

  /**
   * Raw reasoning text delta from the model.
   * Maps to Tessera `thinking` (first delta) or `thinking_update` (subsequent).
   */
  private handleReasoningTextDelta(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    return this.emitThinkingDelta(sessionId, params.itemId, params.delta);
  }

  // ---------------------------------------------------------------------------
  // Notification: item/reasoning/summaryTextDelta
  // ---------------------------------------------------------------------------

  /**
   * Reasoning summary text delta (condensed version of full reasoning).
   * Used as fallback when full reasoning text is not available, or as
   * complementary content. Mapped to the same thinking UI.
   */
  private handleReasoningSummaryTextDelta(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);

    // If full reasoning textDelta is already streaming for this item, skip
    // summary to avoid duplicate content in the thinking UI.
    if (state.activeReasoningItemId === params.itemId && state.activeThinkingId) {
      return [];
    }

    return this.emitThinkingDelta(sessionId, params.itemId, params.delta);
  }

  /**
   * Shared logic for emitting thinking deltas from reasoning text or summary.
   * On first delta for a new itemId: emits `thinking` (status: streaming).
   * On subsequent deltas: emits `thinking_update` (contentDelta).
   */
  private emitThinkingDelta(sessionId: string, itemId: string | undefined, delta: string | undefined): ParsedMessage[] {
    if (!delta || !itemId) return [];

    const state = this.getOrCreateState(sessionId);

    // Suppress after interrupt
    if (state.interrupted) return [];
    const timestamp = new Date().toISOString();

    // New reasoning item → start a new thinking block
    if (state.activeReasoningItemId !== itemId) {
      // Finalize previous thinking block if any
      const messages: ParsedMessage[] = [];
      if (state.activeThinkingId) {
        messages.push({
          serverMessage: {
            type: 'thinking_update',
            sessionId,
            thinkingId: state.activeThinkingId,
            contentDelta: '',
            status: 'completed',
            timestamp,
          },
        });
      }

      const thinkingId = `thinking-codex-${sessionId}-${Date.now()}`;
      state.activeReasoningItemId = itemId;
      state.activeThinkingId = thinkingId;

      messages.push({
        serverMessage: {
          type: 'thinking',
          sessionId,
          content: delta,
          status: 'streaming',
          thinkingId,
          timestamp,
        },
      });

      logger.debug('Codex: new reasoning block started', { sessionId, itemId, thinkingId });
      return messages;
    }

    // Continuing same reasoning item → emit delta update
    if (!state.activeThinkingId) return [];

    return [{
      serverMessage: {
        type: 'thinking_update',
        sessionId,
        thinkingId: state.activeThinkingId,
        contentDelta: delta,
        status: 'streaming',
        timestamp,
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // codex/event/*: Agent Commentary
  // ---------------------------------------------------------------------------

  /**
   * Codex agent commentary message (phase: "commentary", "planning", etc.).
   * Translated into the shared agent_progress progress row so the frontend can
   * render provider-agnostic activity updates without Codex-specific UI code.
   */
  private handleCodexAgentMessage(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const msg = params.msg ?? {};
    const message: string = msg.message ?? '';
    const phase: string = msg.phase ?? 'unknown';

    if (!message) return [];

    logger.info('Codex: agent commentary', { sessionId, phase, messageLength: message.length });

    const timestamp = new Date().toISOString();
    return [{
      serverMessage: {
        type: 'progress_hook',
        sessionId,
        hookEvent: 'agent_progress',
        progressType: 'agent_progress',
        data: {
          type: 'agent_progress',
          message: {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: message }],
            },
            uuid: `codex-agent-progress-${Date.now()}`,
            timestamp,
          },
          normalizedMessages: [],
          prompt: message,
          agentId: 'codex-main',
          ...(phase !== 'unknown' ? { phaseName: phase } : {}),
        },
        timestamp,
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // codex/event/*: Exec Command Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Rich command execution start with parsed_cmd, cwd, process_id.
   * Standard item/started already emits tool_call running, so this is currently
   * used for logging only.
  */
  private handleCodexExecCommandBegin(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const msg = params.msg ?? {};
    const callId: string = msg.call_id ?? '';
    const cwd: string = msg.cwd ?? '';
    const parsedCmd = msg.parsed_cmd ?? [];

    // Extract human-readable command from parsed_cmd if available
    const humanCmd = Array.isArray(parsedCmd) && parsedCmd.length > 0
      ? parsedCmd.map((p: any) => p.cmd ?? '').join('; ')
      : '';

    logger.info('Codex: exec command begin', { sessionId, callId, cwd, humanCmd });

    return [];
  }

  /**
   * Rich command execution end with direct stdout/stderr and exit_code.
   * Standard item/completed plus bash_progress already cover the visible UI.
  */
  private handleCodexExecCommandEnd(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const msg = params.msg ?? {};
    const callId: string = msg.call_id ?? '';
    const exitCode = msg.exit_code ?? msg.exitCode;
    const stdout: string = msg.stdout ?? '';
    const stderr: string = msg.stderr ?? '';

    logger.info('Codex: exec command end', {
      sessionId,
      callId,
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });

    return [];
  }

  // ---------------------------------------------------------------------------
  // codex/event/*: Token Usage
  // ---------------------------------------------------------------------------

  /**
   * Legacy Codex token count event.
   * This payload only exposes cumulative usage, so it should update the final
   * usage summary but must not overwrite the live context bar.
   */
  private handleCodexTokenCount(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const msg = params.msg ?? {};
    const info = msg.info ?? {};
    const totalUsage = info.total_token_usage ?? {};
    const contextWindow = info.model_context_window;
    const usage = this.normalizeCodexInputBreakdown(
      totalUsage.input_tokens,
      totalUsage.cached_input_tokens,
    );

    state.latestUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: totalUsage.output_tokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens,
      reasoningOutputTokens: totalUsage.reasoning_output_tokens ?? 0,
      contextWindowSize: contextWindow ?? undefined,
    };

    logger.info('Codex: token count', {
      sessionId,
      inputTokens: totalUsage.input_tokens,
      outputTokens: totalUsage.output_tokens,
      reasoningTokens: totalUsage.reasoning_output_tokens,
    });

    return [];
  }

  /**
   * Standard protocol thread/tokenUsage/updated.
   * Uses tokenUsage.total for cumulative turn summary and tokenUsage.last for the
   * live context bar.
   */
  private handleThreadTokenUsage(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const tokenUsage = params.tokenUsage ?? {};
    const total = tokenUsage.total ?? {};
    const last = tokenUsage.last ?? null;
    const contextWindow = tokenUsage.modelContextWindow;
    const totalUsage = this.normalizeCodexInputBreakdown(
      total.inputTokens,
      total.cachedInputTokens,
    );

    state.latestUsage = {
      inputTokens: totalUsage.inputTokens,
      outputTokens: total.outputTokens ?? 0,
      cacheReadTokens: totalUsage.cacheReadTokens,
      reasoningOutputTokens: total.reasoningOutputTokens ?? 0,
      contextWindowSize: contextWindow ?? undefined,
    };

    logger.debug('Codex: thread token usage updated', {
      sessionId,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      reasoningTokens: total.reasoningOutputTokens,
    });

    if (!last) {
      return [];
    }

    const lastUsage = this.normalizeCodexInputBreakdown(
      last.inputTokens,
      last.cachedInputTokens,
    );

    return [{
      serverMessage: {
        type: 'context_usage',
        sessionId,
        inputTokens: lastUsage.inputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: lastUsage.cacheReadTokens,
        contextWindowSize: contextWindow ?? undefined,
      },
    }];
  }

  /**
   * OpenAI usage reports cached input as a breakdown of input tokens, while the
   * shared Tessera store expects cache tokens to live in a separate disjoint bucket.
   */
  private normalizeCodexInputBreakdown(
    inputTokens: number | null | undefined,
    cachedInputTokens: number | null | undefined,
  ): { inputTokens: number; cacheReadTokens: number } {
    const totalInputTokens = Math.max(0, inputTokens ?? 0);
    const cacheReadTokens = Math.max(0, Math.min(totalInputTokens, cachedInputTokens ?? 0));
    return {
      inputTokens: totalInputTokens - cacheReadTokens,
      cacheReadTokens,
    };
  }

  private buildRateLimitUpdateMessage(rateLimits: Record<string, any> | null | undefined): ParsedMessage {
    return {
      serverMessage: {
        type: 'rate_limit_update',
        ...buildCodexRateLimitSnapshot(rateLimits),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // codex/event/*: Task & MCP Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Task started with model context window and collaboration mode.
   * Metadata only; visible turn progress is handled by the shared waiting indicator.
   */
  private handleCodexTaskStarted(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const msg = params.msg ?? {};
    const contextWindow = msg.model_context_window;
    const collaborationMode: string = msg.collaboration_mode_kind ?? 'default';

    logger.info('Codex: task started', { sessionId, contextWindow, collaborationMode });

    return [];
  }

  /**
   * MCP server startup update/completion.
   * Translated into shared mcp_progress rows so the UI can render it
   * provider-agnostically.
   */
  private handleCodexMcpStartup(sessionId: string, params: Record<string, any>): ParsedMessage[] {
    const msg = params.msg ?? {};
    const msgType: string = msg.type ?? '';
    const state = this.getOrCreateState(sessionId);
    const timestamp = new Date().toISOString();

    if (msgType === 'mcp_startup_complete') {
      const ready: string[] = msg.ready ?? [];
      const failed: string[] = msg.failed ?? [];
      const cancelled: string[] = msg.cancelled ?? [];

      logger.info('Codex: MCP startup complete', { sessionId, ready, failed, cancelled });

      return [
        ...ready.map((server) => {
          const prev = state.mcpStartupServers.get(server);
          state.mcpStartupServers.set(server, {
            status: 'completed',
            startTimestamp: prev?.startTimestamp ?? timestamp,
          });
          return this.buildMcpProgressMessage(
            sessionId,
            'completed',
            server,
            prev?.startTimestamp,
            timestamp,
          );
        }),
        ...failed.map((server) => {
          const prev = state.mcpStartupServers.get(server);
          state.mcpStartupServers.set(server, {
            status: 'failed',
            startTimestamp: prev?.startTimestamp ?? timestamp,
          });
          return this.buildMcpProgressMessage(
            sessionId,
            'failed',
            server,
            prev?.startTimestamp,
            timestamp,
            'Startup failed',
          );
        }),
        ...cancelled.map((server) => {
          const prev = state.mcpStartupServers.get(server);
          state.mcpStartupServers.set(server, {
            status: 'failed',
            startTimestamp: prev?.startTimestamp ?? timestamp,
          });
          return this.buildMcpProgressMessage(
            sessionId,
            'failed',
            server,
            prev?.startTimestamp,
            timestamp,
            'Startup cancelled',
          );
        }),
      ];
    }

    // mcp_startup_update
    const server: string = msg.server ?? '';
    const status = msg.status ?? {};

    logger.info('Codex: MCP startup update', { sessionId, server, state: status.state });

    if (!server) {
      return [];
    }

    const prev = state.mcpStartupServers.get(server);
    if (prev?.status === 'started') {
      return [];
    }

    state.mcpStartupServers.set(server, {
      status: 'started',
      startTimestamp: prev?.startTimestamp ?? timestamp,
    });

    return [
      this.buildMcpProgressMessage(
        sessionId,
        'started',
        server,
        prev?.startTimestamp ?? timestamp,
        timestamp,
      ),
    ];
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Reset per-turn state fields. Called when a turn ends (completed or aborted).
   */
  private resetTurnState(state: SessionState): void {
    state.accumulatedText = '';
    state.activeTurnId = null;
    state.interrupted = false;
  }

  private buildBashProgressMessage(
    sessionId: string,
    itemId: string,
    startedAtMs: number,
    fullOutputOverride?: string,
  ): ParsedMessage {
    const fullOutput = fullOutputOverride ?? this.getOrCreateState(sessionId).outputBuffers.get(itemId) ?? '';

    return {
      serverMessage: {
        type: 'progress_hook',
        sessionId,
        hookEvent: 'bash_progress',
        progressType: 'bash_progress',
        data: {
          type: 'bash_progress',
          output: this.toOutputPreview(fullOutput),
          fullOutput,
          elapsedTimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
          totalLines: this.countOutputLines(fullOutput),
        },
        timestamp: new Date().toISOString(),
      },
    };
  }

  private buildMcpProgressMessage(
    sessionId: string,
    status: 'started' | 'completed' | 'failed',
    serverName: string,
    startTimestamp: string | undefined,
    timestamp: string,
    errorMessage?: string,
  ): ParsedMessage {
    const elapsedTimeMs = startTimestamp
      ? Math.max(0, new Date(timestamp).getTime() - new Date(startTimestamp).getTime())
      : undefined;

    return {
      serverMessage: {
        type: 'progress_hook',
        sessionId,
        hookEvent: 'mcp_progress',
        progressType: 'mcp_progress',
        data: {
          type: 'mcp_progress',
          status,
          serverName,
          toolName: 'startup',
          ...(status !== 'started' && elapsedTimeMs != null ? { elapsedTimeMs } : {}),
          ...(startTimestamp ? { startTimestamp } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        timestamp,
      },
    };
  }

  private countOutputLines(output: string): number {
    if (!output) return 0;
    const lines = output.split(/\r?\n/);
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  }

  private toOutputPreview(output: string): string {
    if (!output) return '';
    const lines = output.split(/\r?\n/);
    const tailLines = lines.slice(-12).join('\n');
    return tailLines.length > 1200 ? tailLines.slice(-1200) : tailLines;
  }

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = {
        threadId: null,
        activeTurnId: null,
        pendingRequests: new Map(),
        accumulatedText: '',
        outputBuffers: new Map(),
        activeReasoningItemId: null,
        activeThinkingId: null,
        interrupted: false,
        latestUsage: null,
        currentModel: null,
        commandProgress: new Map(),
        mcpStartupServers: new Map(),
        lastCompactBoundaryAtMs: 0,
      };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }

  /**
   * Adapter-callable: register the model used for this session so the result
   * notification can include a modelUsage breakdown labeled with the model name.
   */
  setSessionModel(sessionId: string, model: string | null | undefined): void {
    if (!model) return;
    const state = this.getOrCreateState(sessionId);
    state.currentModel = model;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// =============================================================================
// Singleton
// =============================================================================

const PARSER_KEY = Symbol.for('tessera.codexProtocolParser');
const _g = globalThis as unknown as Record<symbol, CodexProtocolParser>;
export const codexProtocolParser: CodexProtocolParser =
  _g[PARSER_KEY] || (_g[PARSER_KEY] = new CodexProtocolParser());
