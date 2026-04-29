/**
 * Claude Code Protocol Parser
 *
 * Pure parser for Claude Code CLI stdout (JSON Lines / stream-json format).
 * All handler logic is extracted from protocol-adapter.ts.
 *
 * Design constraints:
 *  - No direct calls to processManager, WebSocket send, or any I/O.
 *  - Side effects are described via ParsedMessage.sideEffect and executed by the caller.
 *  - Per-session state is maintained internally in Maps keyed by sessionId.
 *
 * Public API:
 *   parseStdout(sessionId: string, line: string): ParsedMessage[]
 */

import type { ParsedMessage } from '../types';
import type { CliCommandInfo, CliMessage } from '../../types';
import { buildModelUsageEntries, pickPrimaryModelName } from '../../protocol-adapter-events';
import { parseContentBlocks, extractToolResultOutput, extractOutputString } from '../../message-parser';
import { hookHandler } from '../../hook-handler';
import { truncateToolResult } from '../../truncate-tool-result';
import { extractTodoSnapshot, mapClaudeToolNameToToolKind, synthesizeClaudeToolResult } from './synthesize-claude-tool-result';
import logger from '../../../logger';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import { normalizeToolResult } from '@/lib/tool-results/normalize-tool-result';
import { buildToolDisplay } from '@/lib/tool-display';

// =============================================================================
// Internal Session State
// =============================================================================

interface SessionStreamState {
  activeThinkingId: string | null;
  thinkingSignature: string;
  /** True if at least one thinking_delta was received for the active block. */
  hasReceivedThinkingDelta: boolean;
  /** True if we already emitted an isRedacted:true update for the active block. */
  thinkingRedactedEmitted: boolean;
  isStreamingText: boolean;
  /** True if stream_event text deltas were sent this turn. */
  hasStreamedText: boolean;
  /** Dedup: track tool_use IDs already sent to prevent duplicate tool_call messages. */
  processedToolUseIds: Set<string>;
}

interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
}

interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, any>;
}

// =============================================================================
// ClaudeCodeProtocolParser
// =============================================================================

export class ClaudeCodeProtocolParser {
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
  private streamState = new Map<string, SessionStreamState>();

  /**
   * Per-session pending tool calls. The parser tracks these internally so it
   * can correlate tool_result messages back to the original tool_use without
   * accessing processManager.
   */
  private pendingToolCalls = new Map<string, Map<string, PendingToolCall>>();

  /**
   * Per-session pending permission requests.
   */
  private pendingPermissionRequests = new Map<string, Map<string, PendingPermissionRequest>>();

  /** Per-session TodoWrite snapshot for synthesizing rich todo diffs without CLI JSONL. */
  private lastTodoSnapshots = new Map<string, Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>>();

  /**
   * Per-session last assistant message (used for notification preview).
   */
  private lastAssistantMessage = new Map<string, string>();

  /**
   * Per-session model id from the most recent assistant message. Used as a
   * best-effort hint when picking the primary modelUsage entry server-side.
   * NOTE: Anthropic strips suffixes like "[1m]" from the echoed model id,
   * so this hint cannot disambiguate "claude-opus-4-7" vs "[1m]". The
   * authoritative pick happens client-side in buildStatusDisplayModel,
   * which uses the UI-configured model (with suffix) to override the
   * server's contextWindowSize when the modelUsage map carries both.
   */
  private lastAssistantModel = new Map<string, string>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse a single JSON Lines stdout line from the Claude Code CLI.
   * Returns an array of ParsedMessage objects (may be empty for suppressed lines).
   */
  parseStdout(sessionId: string, line: string): ParsedMessage[] {
    try {
      const msg: CliMessage = JSON.parse(line);
      return this.handleMessage(sessionId, msg);
    } catch (err) {
      const error = err as Error;
      logger.error('CLI message handling error', {
        sessionId,
        line: line.substring(0, 100),
        error: error.message,
        stack: error.stack?.substring(0, 300),
      });
      return [];
    }
  }

  /**
   * Clean up per-session state when the CLI process exits.
   * Returns exit notification messages.
   */
  handleProcessExit(sessionId: string, exitCode: number): ParsedMessage[] {
    logger.error('Handling process exit', { sessionId, exitCode });

    this.streamState.delete(sessionId);
    this.contextWindowSizeCache.delete(sessionId);
    this.pendingToolCalls.delete(sessionId);
    this.pendingPermissionRequests.delete(sessionId);
    this.lastAssistantMessage.delete(sessionId);
    this.lastAssistantModel.delete(sessionId);
    this.lastTodoSnapshots.delete(sessionId);

    return [{
      serverMessage: {
        type: 'cli_down',
        sessionId,
        exitCode,
        message: `Claude Code Down (exit code: ${exitCode})`,
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Internal dispatch
  // ---------------------------------------------------------------------------

  private handleMessage(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const startTime = Date.now();

    logger.debug('CLI message received', {
      sessionId,
      type: msg.type,
      hasToolUseId: !!(msg as any).tool_use_id,
    });

    let results: ParsedMessage[];

    switch (msg.type) {
      case 'system':
        results = this.handleSystem(sessionId, msg);
        break;
      case 'assistant':
        results = this.handleAssistant(sessionId, msg);
        break;
      case 'progress':
        results = this.handleProgress(sessionId, msg);
        break;
      case 'result':
        results = this.handleResult(sessionId, msg);
        break;
      case 'tool_result':
        results = this.handleToolResult(sessionId, msg);
        break;
      case 'control_response':
        results = this.handleControlResponse(sessionId, msg);
        break;
      case 'control_request':
        results = this.handleControlRequest(sessionId, msg);
        break;
      case 'user':
        results = this.handleUserMessage(sessionId, msg);
        break;
      case 'stream_event':
        results = this.handleStreamEvent(sessionId, msg);
        break;
      default: {
        const knownIgnored = ['rate_limit_event'];
        if (!knownIgnored.includes(msg.type)) {
          logger.warn('Unknown CLI message type', { sessionId, type: msg.type });
        }
        results = [];
        break;
      }
    }

    const duration = Date.now() - startTime;
    if (duration > 20) {
      logger.warn('Message handling slow', { sessionId, type: msg.type, duration });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Handler: system
  // ---------------------------------------------------------------------------

  private handleControlResponse(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const response = msg.response;
    if (!response) {
      logger.debug('control_response without response body', { sessionId });
      return [];
    }

    if (response.subtype === 'error') {
      logger.warn('control_response error', {
        sessionId,
        error: response.error,
        requestId: response.request_id,
      });
      return [];
    }

    const payload = response.response;
    if (!payload || !Array.isArray(payload.commands)) {
      logger.debug('control_response without commands (non-initialize response)', {
        sessionId,
        requestId: response.request_id,
        hasPayload: !!payload,
        payloadKeys: payload ? Object.keys(payload).join(',') : 'none',
      });
      return [];
    }

    const commands: CliCommandInfo[] = payload.commands
      .filter((command: any) => command && typeof command.name === 'string')
      .map((command: any) => ({
        name: command.name as string,
        description: (command.description as string) || '',
      }));

    logger.info('CLI commands received via initialize', {
      sessionId,
      commandCount: commands.length,
    });

    return [
      {
        serverMessage: null,
        sideEffect: { type: 'store_commands', commands },
      },
      {
        serverMessage: {
          type: 'commands_ready',
          sessionId,
          commands,
          timestamp: new Date().toISOString(),
        },
      },
    ];
  }

  private handleSystem(sessionId: string, msg: CliMessage): ParsedMessage[] {
    if (msg.subtype === 'init') {
      logger.info('CLI process initialized', {
        sessionId,
        model: msg.message?.model,
        tools: msg.message?.tools?.length,
      });

      const results: ParsedMessage[] = [];

      // Emit update_status side effect (processManager.updateStatus)
      results.push({ serverMessage: null, sideEffect: { type: 'set_generating', value: false } });

      if (typeof msg.message?.model === 'string' && msg.message.model.trim()) {
        results.push({
          serverMessage: {
            type: 'system',
            sessionId,
            message: `Using ${msg.message.model}`,
            severity: 'info',
            timestamp: new Date().toISOString(),
          },
        });
      }

      return results;
    } else if (msg.subtype === 'hook_started') {
      logger.debug('Hook started', { sessionId, hookName: msg.message?.hook_name });
      return [];
    } else if (msg.subtype === 'hook_response') {
      logger.debug('Hook response', {
        sessionId,
        hookName: msg.message?.hook_name,
        outcome: msg.message?.outcome,
      });
      return [];
    } else {
      return this.parseSystemMessage(sessionId, msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: assistant
  // ---------------------------------------------------------------------------

  /**
   * Handle assistant messages (Claude responses).
   *
   * With --include-partial-messages always enabled, the CLI emits assistant
   * snapshot messages alongside stream_event deltas.  Text and thinking are
   * handled by stream_event; this method only processes tool_use blocks and
   * collects text for notification preview.
   * processedToolUseIds prevents duplicate tool_call from multiple snapshots.
   */
  private handleAssistant(sessionId: string, msg: CliMessage): ParsedMessage[] {
    if (!msg.message?.content) {
      logger.warn('Assistant message without content', { sessionId });
      return [];
    }

    if (typeof msg.message.model === 'string' && msg.message.model.trim()) {
      this.lastAssistantModel.set(sessionId, msg.message.model);
    }

    const results: ParsedMessage[] = [];
    let textContent = '';
    const parsedBlocks = parseContentBlocks(msg.message.content);

    for (const block of parsedBlocks) {
      switch (block.type) {
        case 'text':
          textContent += block.text;
          break;

        case 'thinking':
          // Thinking is always sent via stream_event (--include-partial-messages).
          break;

        case 'redacted_thinking':
          results.push({
            serverMessage: {
              type: 'thinking',
              sessionId,
              content: '',
              status: 'completed',
              isRedacted: true,
              timestamp: new Date().toISOString(),
            },
          });
          logger.debug('Redacted thinking block detected', { sessionId });
          break;

        case 'tool_use': {
          const streamSt = this.streamState.get(sessionId);
          if (streamSt && block.id && streamSt.processedToolUseIds.has(block.id)) {
            break;
          }
          streamSt?.processedToolUseIds.add(block.id);

          // Parse and emit tool call messages + side effects
          const toolCallMessages = this.parseToolUse(sessionId, block);
          results.push(...toolCallMessages);

          // Handle interactive prompts (AskUserQuestion)
          const promptMessages = this.handleInteractivePrompt(sessionId, block);
          results.push(...promptMessages);
          break;
        }
      }
    }

    // If text arrived without preceding stream_event deltas (e.g. <synthetic>
    // API error messages), emit it directly so the chat area shows it.
    const streamSt = this.streamState.get(sessionId);
    if (textContent.trim() && streamSt && !streamSt.hasStreamedText) {
      results.push({
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: textContent,
        },
      });
      logger.info('Emitted non-streamed assistant text', {
        sessionId,
        length: textContent.length,
      });
    }

    // Store last assistant message for notification preview
    if (textContent.trim()) {
      this.lastAssistantMessage.set(sessionId, textContent);
      results.push({
        serverMessage: null,
        sideEffect: { type: 'update_last_assistant_message', content: textContent },
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Helper: parseToolUse
  // ---------------------------------------------------------------------------

  private parseToolUse(sessionId: string, toolUse: any): ParsedMessage[] {
    if (!toolUse.name || !toolUse.id) {
      logger.warn('Malformed tool_use (missing name or id)', { sessionId, toolUse });
      return [];
    }

    const toolName = toolUse.name;
    const toolKind = mapClaudeToolNameToToolKind(toolName);
    const toolParams = toolUse.input || {};
    const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
    const toolUseId = toolUse.id;
    const syntheticToolUseResult = synthesizeClaudeToolResult(toolKind, toolParams, {
      previousTodos: this.lastTodoSnapshots.get(sessionId),
    });

    // Track pending tool call in local state
    if (!this.pendingToolCalls.has(sessionId)) {
      this.pendingToolCalls.set(sessionId, new Map());
    }
    this.pendingToolCalls.get(sessionId)!.set(toolUseId, { toolName, toolKind, toolParams, toolDisplay });

    logger.info('Tool call detected', {
      sessionId,
      toolName,
      toolUseId,
      paramsKeys: Object.keys(toolParams),
    });

    return [
      {
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
          status: 'running',
          ...(syntheticToolUseResult !== undefined ? { toolUseResult: syntheticToolUseResult } : {}),
          toolUseId,
          timestamp: new Date().toISOString(),
        },
        sideEffect: {
          type: 'add_pending_tool_call',
          toolUseId,
          toolName,
          ...(toolKind !== undefined ? { toolKind } : {}),
          toolParams,
          ...(toolDisplay !== undefined ? { toolDisplay } : {}),
        },
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Helper: parseProgressHook
  // ---------------------------------------------------------------------------

  private parseProgressHook(sessionId: string, hookEvent: string, data: any): ParsedMessage[] {
    const relevantHooks = ['BeforeToolCall', 'AfterToolCall', 'Start', 'Stop'];

    if (!relevantHooks.includes(hookEvent)) {
      logger.debug('Ignoring non-relevant hook', { sessionId, hookEvent });
      return [];
    }

    const hookData: Record<string, any> = {};

    if (hookEvent === 'BeforeToolCall' || hookEvent === 'AfterToolCall') {
      hookData.toolName = data.toolName || data.tool_name;
      hookData.step = hookEvent === 'BeforeToolCall' ? 'starting' : 'completed';
    } else if (hookEvent === 'Start') {
      hookData.action = 'Task started';
    } else if (hookEvent === 'Stop') {
      hookData.action = 'Task completed';
    }

    logger.debug('Progress hook sent', { sessionId, hookEvent, dataKeys: Object.keys(hookData) });

    return [{
      serverMessage: {
        type: 'progress_hook',
        sessionId,
        hookEvent,
        data: hookData,
        timestamp: new Date().toISOString(),
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Helper: parseSystemMessage
  // ---------------------------------------------------------------------------

  private parseSystemMessage(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const raw = msg as any;
    const subtype = raw.subtype as string | undefined;

    const metadata: Record<string, any> = {};
    if (subtype === 'api_error') {
      metadata.error = raw.error;
      metadata.retryInMs = raw.retryInMs;
      metadata.retryAttempt = raw.retryAttempt;
      metadata.maxRetries = raw.maxRetries;
    } else if (subtype === 'turn_duration') {
      metadata.durationMs = raw.durationMs;
    } else if (subtype === 'stop_hook_summary') {
      metadata.hookCount = raw.hookCount;
      metadata.hookInfos = raw.hookInfos;
      metadata.hookErrors = raw.hookErrors;
    } else if (subtype === 'compact_boundary') {
      metadata.compactMetadata = raw.compact_metadata || raw.compactMetadata;
    }

    const messageText = raw.content || raw.message?.text || raw.message?.content;

    if (!messageText && !subtype) {
      logger.warn('System message without text or subtype', { sessionId });
      return [];
    }

    const severity: 'info' | 'warning' | 'error' =
      subtype === 'api_error' ? 'error'
      : raw.level === 'error' ? 'error'
      : raw.level === 'warning' ? 'warning'
      : typeof messageText === 'string' && (messageText.toLowerCase().includes('error') || messageText.toLowerCase().includes('failed')) ? 'error'
      : typeof messageText === 'string' && (messageText.toLowerCase().includes('warning') || messageText.toLowerCase().includes('context')) ? 'warning'
      : 'info';

    logger.info('System message sent', {
      sessionId,
      severity,
      subtype,
      message: typeof messageText === 'string' ? messageText.substring(0, 50) : String(messageText).substring(0, 50),
    });

    return [{
      serverMessage: {
        type: 'system',
        sessionId,
        message: typeof messageText === 'string' ? messageText : JSON.stringify(messageText || ''),
        severity,
        subtype,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        timestamp: new Date().toISOString(),
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Handler: tool_result
  // ---------------------------------------------------------------------------

  /**
   * Handle tool_result messages (CLI sends these after tool execution).
   */
  private handleToolResult(sessionId: string, msg: CliMessage): ParsedMessage[] {
    if (msg.type !== 'tool_result' || !msg.tool_use_id) {
      logger.warn('tool_result without tool_use_id', { sessionId });
      return [];
    }

    const toolUseId = msg.tool_use_id;
    const isError = msg.message?.is_error || false;
    const rawContent = msg.message?.content;
    const output = extractOutputString(rawContent);

    const sessionPending = this.pendingToolCalls.get(sessionId);
    const pendingTool = sessionPending?.get(toolUseId);

    if (!pendingTool) {
      if (isError && output.trim() === 'Answer questions?') {
        return [{
          serverMessage: {
            type: 'system',
            sessionId,
            message: 'AskUserQuestion permission prompt was auto-denied in non-interactive mode.',
            severity: 'warning',
            timestamp: new Date().toISOString(),
          },
        }];
      }
      logger.warn('tool_result for unknown tool_use_id', { sessionId, toolUseId });
      return [];
    }

    // Remove from local pending state
    sessionPending!.delete(toolUseId);

    logger.info('Tool result received', {
      sessionId,
      toolName: pendingTool.toolName,
      isError,
      outputLength: output?.length || 0,
    });

    const syntheticToolUseResult = synthesizeClaudeToolResult(pendingTool.toolKind, pendingTool.toolParams, {
      output,
      error: isError ? output : undefined,
      isError,
      previousTodos: this.lastTodoSnapshots.get(sessionId),
    });

    const nextTodos = extractTodoSnapshot(pendingTool.toolKind, pendingTool.toolParams);
    if (nextTodos) {
      this.lastTodoSnapshots.set(sessionId, nextTodos);
    }

    return [{
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolName: pendingTool.toolName,
        ...(pendingTool.toolKind !== undefined ? { toolKind: pendingTool.toolKind } : {}),
        toolParams: pendingTool.toolParams,
        ...(pendingTool.toolDisplay !== undefined ? { toolDisplay: pendingTool.toolDisplay } : {}),
        status: isError ? 'error' : 'completed',
        output: isError ? undefined : output,
        error: isError ? output : undefined,
        ...(syntheticToolUseResult !== undefined ? { toolUseResult: syntheticToolUseResult } : {}),
        toolUseId,
        timestamp: new Date().toISOString(),
      },
      sideEffect: { type: 'remove_pending_tool_call', toolUseId },
    }];
  }

  // ---------------------------------------------------------------------------
  // Handler: user
  // ---------------------------------------------------------------------------

  /**
   * Handle user messages from CLI stdout.
   * Note: In --print stream-json mode, the CLI does NOT send type='user' messages
   * for tool results on stdout (those only exist in JSONL files). This handler
   * may fire for other user message types (e.g., --replay-user-messages flag).
   */
  private handleUserMessage(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];

    const rawToolUseResult = (msg as any).toolUseResult;
    const results: ParsedMessage[] = [];

    for (const block of content) {
      const toolResult = extractToolResultOutput(block);
      if (!toolResult) continue;

      const sessionPending = this.pendingToolCalls.get(sessionId);
      const pendingTool = sessionPending?.get(toolResult.toolUseId);
      if (!pendingTool) continue;

      const toolUseResult = rawToolUseResult
        ? normalizeToolResult(
            pendingTool.toolKind,
            truncateToolResult(rawToolUseResult, {
              sessionId,
              toolName: pendingTool.toolName,
            }),
          )
        : synthesizeClaudeToolResult(pendingTool.toolKind, pendingTool.toolParams, {
            output: toolResult.output,
            error: toolResult.isError ? toolResult.output : undefined,
            isError: toolResult.isError,
            previousTodos: this.lastTodoSnapshots.get(sessionId),
          });

      sessionPending!.delete(toolResult.toolUseId);

      const nextTodos = extractTodoSnapshot(pendingTool.toolKind, pendingTool.toolParams);
      if (nextTodos) {
        this.lastTodoSnapshots.set(sessionId, nextTodos);
      }

      logger.debug('Tool result from user message', {
        sessionId,
        toolName: pendingTool.toolName,
        toolUseId: toolResult.toolUseId,
        isError: toolResult.isError,
        hasToolUseResult: !!rawToolUseResult,
        outputLength: toolResult.output?.length || 0,
      });

      results.push({
        serverMessage: {
          type: 'tool_call',
          sessionId,
          toolName: pendingTool.toolName,
          ...(pendingTool.toolKind !== undefined ? { toolKind: pendingTool.toolKind } : {}),
          toolParams: pendingTool.toolParams,
          ...(pendingTool.toolDisplay !== undefined ? { toolDisplay: pendingTool.toolDisplay } : {}),
          status: toolResult.isError ? 'error' : 'completed',
          output: toolResult.isError ? undefined : toolResult.output,
          error: toolResult.isError ? toolResult.output : undefined,
          toolUseResult,
          toolUseId: toolResult.toolUseId,
          timestamp: new Date().toISOString(),
        },
        sideEffect: { type: 'remove_pending_tool_call', toolUseId: toolResult.toolUseId },
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Handler: control_request
  // ---------------------------------------------------------------------------

  /**
   * Handle SDK control_request messages (permission prompts, AskUserQuestion, etc.).
   *
   * When the CLI needs a permission decision or user input, it sends a control_request
   * on stdout and waits for a control_response on stdin. This is the SDK protocol for
   * handling tool permissions and AskUserQuestion interactively.
   */
  private handleControlRequest(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const request = msg.request;
    const requestId = msg.request_id;

    if (!request || !requestId) {
      logger.warn('control_request without request or request_id', { sessionId });
      return [];
    }

    if (request.subtype !== 'can_use_tool') {
      logger.warn('Unhandled control_request subtype', {
        sessionId,
        subtype: request.subtype,
        requestId,
      });
      // Return a side effect so the caller can send an error control_response
      return [{
        serverMessage: null,
        sideEffect: {
          type: 'add_pending_permission_request',
          toolUseId: requestId,
          requestId,
          toolName: '',
          input: { _error: `Unsupported control request subtype: ${request.subtype}` },
        },
      }];
    }

    const toolName = request.tool_name || '';
    const toolInput = request.input || {};
    const toolUseId = request.tool_use_id || '';

    // Track in local state
    if (!this.pendingPermissionRequests.has(sessionId)) {
      this.pendingPermissionRequests.set(sessionId, new Map());
    }

    if (toolName === 'AskUserQuestion' && toolUseId) {
      this.pendingPermissionRequests.get(sessionId)!.set(toolUseId, {
        requestId,
        toolName,
        input: toolInput,
      });

      logger.info('AskUserQuestion control_request queued (awaiting user response)', {
        sessionId,
        requestId,
        toolUseId,
      });

      // Do not auto-approve AskUserQuestion — wait for user-provided interactive_response.
      return [{
        serverMessage: null,
        sideEffect: {
          type: 'add_pending_permission_request',
          toolUseId,
          requestId,
          toolName,
          input: toolInput,
        },
      }];
    }

    // Forward permission request to frontend for user decision
    const mapKey = toolUseId || requestId;
    this.pendingPermissionRequests.get(sessionId)!.set(mapKey, {
      requestId,
      toolName,
      input: toolInput,
    });

    logger.info('Permission request forwarded to frontend', {
      sessionId,
      requestId,
      toolName,
      toolUseId,
    });

    return [{
      serverMessage: {
        type: 'interactive_prompt',
        sessionId,
        promptType: toolName === 'ExitPlanMode' ? 'plan_approval' : 'permission_request',
        data: toolName === 'ExitPlanMode'
          ? {
              question: '',
              toolUseId: toolUseId || requestId,
              plan: toolInput.plan,
              allowedPrompts: toolInput.allowedPrompts,
              planFilePath: toolInput.planFilePath,
            }
          : {
              question: '',
              toolUseId: toolUseId || requestId,
              toolName,
              toolInput,
              decisionReason: request.decision_reason,
              agentId: request.agent_id,
            },
      },
      sideEffect: {
        type: 'add_pending_permission_request',
        toolUseId: mapKey,
        requestId,
        toolName,
        input: toolInput,
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Handler: interactive prompts (tool_use helper)
  // ---------------------------------------------------------------------------

  private handleInteractivePrompt(sessionId: string, toolUse: any): ParsedMessage[] {
    if (toolUse.name !== 'AskUserQuestion') return [];

    const input = toolUse.input || {};

    if (input.questions && Array.isArray(input.questions) && input.questions.length > 0) {
      logger.info('AskUserQuestion prompt sent (new format)', {
        sessionId,
        questionCount: input.questions.length,
      });

      return [{
        serverMessage: {
          type: 'interactive_prompt',
          sessionId,
          promptType: 'ask_user_question',
          data: {
            question: '',
            toolUseId: toolUse.id,
            questions: input.questions.map((q: any) => ({
              ...q,
              options: q.options?.map((opt: any) => ({
                ...opt,
                markdown: opt.preview ?? opt.markdown,
              })),
            })),
            metadata: input.metadata,
          },
        },
      }];
    }

    // Legacy fallback: single question / simple options
    logger.info('Interactive prompt detected (legacy)', {
      sessionId,
      promptType: input.options ? 'select' : 'input',
      question: input.question,
    });

    return [{
      serverMessage: {
        type: 'interactive_prompt',
        sessionId,
        promptType: input.options ? 'select' : 'input',
        data: {
          question: input.question || '',
          options: Array.isArray(input.options) ? input.options : [],
          toolUseId: toolUse.id,
        },
      },
    }];
  }

  // ---------------------------------------------------------------------------
  // Handler: progress
  // ---------------------------------------------------------------------------

  private handleProgress(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const raw = msg as any;
    const dataType = raw.data?.type;

    if (dataType && ['bash_progress', 'agent_progress', 'mcp_progress',
        'waiting_for_task', 'search_results_received', 'query_update'].includes(dataType)) {
      logger.debug('Typed progress sent', { sessionId, progressType: dataType });
      return [{
        serverMessage: {
          type: 'progress_hook',
          sessionId,
          hookEvent: dataType,
          progressType: dataType,
          data: raw.data,
          timestamp: new Date().toISOString(),
        },
      }];
    }

    const hookEvent = raw.data?.hookEvent;

    if (!hookEvent) {
      logger.warn('Progress message without hookEvent or data.type', { sessionId });
      return [];
    }

    const results: ParsedMessage[] = this.parseProgressHook(sessionId, hookEvent, raw.data);

    if (hookEvent === 'Stop') {
      const lastMessage = this.lastAssistantMessage.get(sessionId);

      hookHandler.handleStopHook(sessionId, '', lastMessage);

      const preview = lastMessage?.substring(0, 50) || '';

      results.push({
        serverMessage: {
          type: 'notification',
          sessionId,
          event: 'completed',
          message: 'Task completed.',
          preview: preview + (lastMessage && lastMessage.length > 50 ? '...' : ''),
        },
      });

      logger.info('Task completion notification sent', { sessionId, preview });
    } else if (hookEvent === 'SessionStart') {
      hookHandler.handleSessionStartHook(sessionId, '');
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Handler: result
  // ---------------------------------------------------------------------------

  private handleResult(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const raw = msg as any;
    const resultText = raw.result || '';
    const usage = raw.usage || msg.message?.usage || {};
    const durationMs = raw.duration_ms || msg.message?.duration_ms;
    const durationApiMs = raw.duration_api_ms || msg.message?.duration_api_ms;
    const numTurns = raw.num_turns || msg.message?.num_turns;
    const costUsd = raw.total_cost_usd || msg.message?.total_cost_usd;

    const results: ParsedMessage[] = [];

    // If the result contains text that was NOT already streamed via stream_events,
    // emit it as an assistant message (e.g. /cost, /context local command output).
    const streamStForResult = this.streamState.get(sessionId);
    if (typeof resultText === 'string' && resultText.trim() &&
        (!streamStForResult || !streamStForResult.hasStreamedText)) {
      results.push({
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: resultText,
        },
      });
    }

    // Extract contextWindowSize from modelUsage. Match against the latest
    // assistant message's model — Claude Code reports secondary models
    // (e.g. Haiku used for internal compaction) in modelUsage, and the map
    // appears to accumulate across the session, so neither first-key nor
    // max-outputTokens is reliable when the user switches models mid-chat.
    const modelUsageRaw = raw.modelUsage || {};
    const assistantModelHint = this.lastAssistantModel.get(sessionId);
    const primaryModelName = pickPrimaryModelName(modelUsageRaw, assistantModelHint);
    const contextWindowSize = primaryModelName ? modelUsageRaw[primaryModelName].contextWindow : undefined;
    const maxOutputTokens = primaryModelName ? modelUsageRaw[primaryModelName].maxOutputTokens : undefined;

    if (contextWindowSize && contextWindowSize > 0) {
      this.contextWindowSizeCache.set(sessionId, contextWindowSize);
    }

    logger.info('MODEL USAGE', {
      sessionId,
      assistantModelHint,
      primaryModelName,
      contextWindowSize,
      maxOutputTokens,
      modelUsage: modelUsageRaw,
    });

    logger.info('Task result received', {
      sessionId,
      success: !raw.is_error,
      duration: durationMs,
      turns: numTurns,
      cost: costUsd,
    });

    // Side effects: update process status
    results.push({
      serverMessage: null,
      sideEffect: { type: 'set_generating', value: false },
    });

    // Reset hasStreamedText for the next turn
    const streamSt = this.streamState.get(sessionId);
    if (streamSt) {
      streamSt.hasStreamedText = false;
      streamSt.processedToolUseIds.clear();
    }

    // Send completion notification with usage data
    const lastMessage = this.lastAssistantMessage.get(sessionId);
    const preview = lastMessage?.substring(0, 50) || '';

    results.push({
      serverMessage: {
        type: 'notification',
        sessionId,
        event: 'completed',
        message: 'Task completed.',
        preview: preview + (lastMessage && lastMessage.length > 50 ? '...' : ''),
        usage: {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheCreationTokens: usage.cache_creation_input_tokens || 0,
          cacheCreationEphemeral5m: usage.cache_creation?.ephemeral_5m_input_tokens,
          cacheCreationEphemeral1h: usage.cache_creation?.ephemeral_1h_input_tokens,
          durationMs: durationMs || 0,
          durationApiMs: durationApiMs || 0,
          numTurns: numTurns || 0,
          costUsd: costUsd || 0,
          serviceTier: usage.service_tier || undefined,
          inferenceGeo: usage.inference_geo || undefined,
          serverToolUse: usage.server_tool_use ? {
            webSearchRequests: usage.server_tool_use.web_search_requests || 0,
            webFetchRequests: usage.server_tool_use.web_fetch_requests || 0,
          } : undefined,
          speed: usage.speed || undefined,
          contextWindowSize: contextWindowSize || undefined,
          maxOutputTokens: maxOutputTokens || undefined,
          modelUsage: buildModelUsageEntries(modelUsageRaw),
        },
      },
    });

    if (!raw.is_error) {
      results.push({
        serverMessage: null,
        sideEffect: { type: 'auto_generate_title' },
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Handler: stream_event
  // ---------------------------------------------------------------------------

  private handleStreamEvent(sessionId: string, msg: CliMessage): ParsedMessage[] {
    const event = msg.event;
    if (!event) return [];

    switch (event.type) {
      case 'message_start':
        return this.handleMessageStart(sessionId, event);
      case 'content_block_start':
        return this.handleContentBlockStart(sessionId, event);
      case 'content_block_delta':
        return this.handleContentBlockDelta(sessionId, event);
      case 'content_block_stop':
        return this.handleContentBlockStop(sessionId);
      default:
        return [];
    }
  }

  private handleMessageStart(sessionId: string, event: any): ParsedMessage[] {
    const usage = event.message?.usage;
    if (!usage) return [];

    if (typeof event.message?.model === 'string' && event.message.model.trim()) {
      this.lastAssistantModel.set(sessionId, event.message.model);
    }

    const contextWindowSize = this.contextWindowSizeCache.get(sessionId);
    return [{
      serverMessage: {
        type: 'context_usage',
        sessionId,
        inputTokens: usage.input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        contextWindowSize: contextWindowSize || undefined,
      },
    }];
  }

  private getOrCreateStreamState(sessionId: string): SessionStreamState {
    let state = this.streamState.get(sessionId);
    if (!state) {
      state = {
        activeThinkingId: null,
        thinkingSignature: '',
        hasReceivedThinkingDelta: false,
        thinkingRedactedEmitted: false,
        isStreamingText: false,
        hasStreamedText: false,
        processedToolUseIds: new Set(),
      };
      this.streamState.set(sessionId, state);
    }
    return state;
  }

  private handleContentBlockStart(sessionId: string, event: any): ParsedMessage[] {
    const block = event.content_block;
    if (!block) return [];

    const state = this.getOrCreateStreamState(sessionId);

    if (block.type === 'thinking') {
      const thinkingId = `thinking-stream-${sessionId}-${Date.now()}`;
      state.activeThinkingId = thinkingId;
      state.thinkingSignature = '';
      state.hasReceivedThinkingDelta = false;
      state.thinkingRedactedEmitted = false;

      return [{
        serverMessage: {
          type: 'thinking',
          sessionId,
          content: '',
          status: 'streaming',
          thinkingId,
          timestamp: new Date().toISOString(),
        },
      }];
    } else if (block.type === 'text') {
      state.isStreamingText = true;
      state.hasStreamedText = true;

      return [{
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: '',
        },
      }];
    }

    // tool_use blocks are handled by handleAssistant (from the assistant snapshot).
    return [];
  }

  private handleContentBlockDelta(sessionId: string, event: any): ParsedMessage[] {
    const delta = event.delta;
    if (!delta) return [];

    const state = this.streamState.get(sessionId);
    if (!state) return [];

    if (delta.type === 'text_delta' && delta.text) {
      return [{
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: delta.text,
        },
      }];
    } else if (delta.type === 'thinking_delta' && delta.thinking && state.activeThinkingId) {
      state.hasReceivedThinkingDelta = true;
      return [{
        serverMessage: {
          type: 'thinking_update',
          sessionId,
          thinkingId: state.activeThinkingId,
          contentDelta: delta.thinking,
          status: 'streaming',
          timestamp: new Date().toISOString(),
        },
      }];
    } else if (delta.type === 'signature_delta' && delta.signature) {
      state.thinkingSignature += delta.signature;
      if (
        !state.hasReceivedThinkingDelta &&
        !state.thinkingRedactedEmitted &&
        state.activeThinkingId
      ) {
        state.thinkingRedactedEmitted = true;
        return [{
          serverMessage: {
            type: 'thinking_update',
            sessionId,
            thinkingId: state.activeThinkingId,
            contentDelta: '',
            status: 'streaming',
            isRedacted: true,
            timestamp: new Date().toISOString(),
          },
        }];
      }
    }

    return [];
  }

  private handleContentBlockStop(sessionId: string): ParsedMessage[] {
    const state = this.streamState.get(sessionId);
    if (!state) return [];

    const results: ParsedMessage[] = [];

    if (state.activeThinkingId) {
      const isRedacted =
        !state.hasReceivedThinkingDelta && !!state.thinkingSignature;
      results.push({
        serverMessage: {
          type: 'thinking_update',
          sessionId,
          thinkingId: state.activeThinkingId,
          contentDelta: '',
          status: 'completed',
          signature: state.thinkingSignature || undefined,
          ...(isRedacted ? { isRedacted: true } : {}),
          timestamp: new Date().toISOString(),
        },
      });
      state.activeThinkingId = null;
      state.thinkingSignature = '';
      state.hasReceivedThinkingDelta = false;
      state.thinkingRedactedEmitted = false;
    }

    if (state.isStreamingText) {
      state.isStreamingText = false;
    }

    return results;
  }
}

// =============================================================================
// Singleton
// =============================================================================

const PARSER_KEY = Symbol.for('tessera.claudeCodeProtocolParser');
const _g = globalThis as unknown as Record<symbol, ClaudeCodeProtocolParser>;
export const claudeCodeProtocolParser: ClaudeCodeProtocolParser =
  _g[PARSER_KEY] || (_g[PARSER_KEY] = new ClaudeCodeProtocolParser());
