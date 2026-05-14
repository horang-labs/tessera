import { randomUUID } from 'crypto';
import type { ParsedMessage } from '../types';
import logger from '@/lib/logger';
import { inferToolCallKindFromToolName, type ToolCallKind } from '@/types/tool-call-kind';
import { buildToolDisplay } from '@/lib/tool-display';
import type { TodoItem } from '@/types/cli-jsonl-schemas';
import type { CanonicalToolResultValue } from '@/types/tool-result';
import type { ContentBlock, ImageContentBlock } from '@/lib/ws/message-types';

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: number | string;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number | string;
}

interface PendingRequest {
  method: string;
  startedAtMs: number;
}

interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  startedAtMs: number;
  previousTodos?: TodoItem[];
}

interface SessionState {
  pendingRequests: Map<number | string, PendingRequest>;
  pendingToolCalls: Map<string, PendingToolCall>;
  accumulatedText: string;
  activeThinkingId: string | null;
  latestUsageUpdate: {
    used?: number;
    size?: number;
    cost?: number;
  } | null;
  currentModel: string | null;
  lastTodoSnapshots: TodoItem[];
}

const MAX_ACCUMULATED_TEXT_LENGTH = 100;
const DISPLAY_ONLY_OPENCODE_SESSION_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'current_mode_update',
  'plan',
  'plan_update',
  'session_info_update',
  'usage_update',
  'user_message_chunk',
]);

export class OpenCodeProtocolParser {
  private sessionStates = new Map<string, SessionState>();

  parseStdout(sessionId: string, line: string): ParsedMessage[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn('OpenCode: non-JSON stdout line, emitting as raw message', {
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

    const hasMethod = typeof parsed.method === 'string';
    const hasId = 'id' in parsed;

    if (hasId && hasMethod) {
      return this.handleServerRequest(sessionId, parsed as JsonRpcServerRequest);
    }
    if (hasId) {
      return this.handleResponse(sessionId, parsed as JsonRpcResponse);
    }
    if (hasMethod) {
      return this.handleNotification(sessionId, parsed as JsonRpcNotification);
    }

    return [buildOpenCodeSystemWarning(
      sessionId,
      'opencode_unknown_stdout',
      'OpenCode emitted a JSON line without method or id.',
      { rawPreview: stringifyPreview(parsed) },
    )];
  }

  trackPendingRequest(sessionId: string, requestId: number | string, method: string): void {
    const state = this.getOrCreateState(sessionId);
    state.pendingRequests.set(requestId, {
      method,
      startedAtMs: Date.now(),
    });
  }

  setSessionModel(sessionId: string, model: string | null | undefined): void {
    const state = this.getOrCreateState(sessionId);
    state.currentModel = model ?? null;
  }

  handleProcessExit(sessionId: string, exitCode: number): ParsedMessage[] {
    this.sessionStates.delete(sessionId);
    return [{
      serverMessage: {
        type: 'cli_down',
        sessionId,
        exitCode,
        message: `OpenCode Down (exit code: ${exitCode})`,
      },
    }];
  }

  private handleServerRequest(sessionId: string, msg: JsonRpcServerRequest): ParsedMessage[] {
    if (msg.method === 'session/request_permission') {
      return this.handlePermissionRequest(sessionId, msg.id, msg.params ?? {});
    }

    logger.debug('OpenCode: unknown server request suppressed', {
      sessionId,
      method: msg.method,
    });
    return [buildOpenCodeSystemWarning(
      sessionId,
      'opencode_unknown_server_request',
      `Unhandled OpenCode server request: ${msg.method}`,
      {
        method: msg.method,
        requestId: String(msg.id),
        rawPreview: stringifyPreview(msg.params ?? {}),
      },
    )];
  }

  private handleResponse(sessionId: string, msg: JsonRpcResponse): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const pending = state.pendingRequests.get(msg.id);
    state.pendingRequests.delete(msg.id);

    if (msg.error) {
      logger.error('OpenCode: JSON-RPC error response', {
        sessionId,
        id: msg.id,
        method: pending?.method,
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

    if (pending?.method === 'session/prompt') {
      return this.handlePromptCompleted(sessionId, msg.result ?? {}, pending.startedAtMs);
    }

    if (pending?.method === 'session/set_model') {
      const meta = msg.result?._meta?.opencode;
      if (typeof meta?.modelId === 'string') {
        state.currentModel = meta.variant ? `${meta.modelId}/${meta.variant}` : meta.modelId;
      }
    }

    if (pending) {
      return [buildOpenCodeSystemInfo(sessionId, 'opencode_response', `OpenCode response received for ${pending.method}.`, {
        method: pending.method,
        result: msg.result ?? null,
      })];
    }

    return [];
  }

  private handleNotification(sessionId: string, msg: JsonRpcNotification): ParsedMessage[] {
    if (msg.method !== 'session/update') {
      return [buildOpenCodeSystemWarning(
        sessionId,
        'opencode_unknown_notification',
        `Unhandled OpenCode notification: ${msg.method}`,
        { method: msg.method, rawPreview: stringifyPreview(msg.params ?? {}) },
      )];
    }

    const update = msg.params?.update;
    if (!update || typeof update !== 'object') {
      return [buildOpenCodeSystemWarning(
        sessionId,
        'opencode_malformed_session_update',
        'OpenCode session/update notification did not include an update object.',
        { rawPreview: stringifyPreview(msg.params ?? {}) },
      )];
    }

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return this.handleUserMessageChunk(sessionId, update.content);
      case 'agent_message_chunk':
        return this.handleAgentMessageChunk(sessionId, update.content);
      case 'agent_thought_chunk':
        return this.handleThoughtChunk(sessionId, update.content);
      case 'tool_call':
      case 'tool_call_update':
        return this.handleToolCallUpdate(sessionId, update);
      case 'usage_update':
        return this.handleUsageUpdate(sessionId, update);
      case 'available_commands_update':
        return this.handleAvailableCommands(sessionId, update.availableCommands);
      case 'plan':
      case 'plan_update':
        return this.handlePlanUpdate(sessionId, update);
      case 'current_mode_update':
        return this.handleCurrentModeUpdate(sessionId, update);
      case 'config_option_update':
        return this.handleConfigOptionUpdate(sessionId, update);
      case 'session_info_update':
        return this.handleSessionInfoUpdate(sessionId, update);
      default:
        logger.debug('OpenCode: unsupported session update suppressed', {
          sessionId,
          sessionUpdate: update.sessionUpdate,
        });
        return this.handleUnsupportedSessionUpdate(sessionId, update);
    }
  }

  private handlePermissionRequest(
    sessionId: string,
    requestId: number | string,
    params: Record<string, any>,
  ): ParsedMessage[] {
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolUseId = String(toolCall.toolCallId ?? requestId);
    const toolName = normalizeToolName(toolCall.title ?? toolCall.kind ?? 'Tool');
    const toolInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};

    logger.info('OpenCode: permission request received', {
      sessionId,
      requestId,
      toolUseId,
      toolName,
    });

    return [
      ...this.completeActiveThinking(sessionId),
      {
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
      },
    ];
  }

  private handleUserMessageChunk(sessionId: string, content: unknown): ParsedMessage[] {
    const normalizedContent = normalizeUserMessageContent(content);
    if (
      normalizedContent === undefined ||
      (typeof normalizedContent === 'string' && normalizedContent.length === 0) ||
      (Array.isArray(normalizedContent) && normalizedContent.length === 0)
    ) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      {
        serverMessage: {
          type: 'user_message',
          sessionId,
          content: normalizedContent,
          timestamp: new Date().toISOString(),
        },
      },
    ];
  }

  private handleAgentMessageChunk(sessionId: string, content: unknown): ParsedMessage[] {
    const text = extractText(content);
    if (!text) return [];

    const state = this.getOrCreateState(sessionId);
    if (state.accumulatedText.length < MAX_ACCUMULATED_TEXT_LENGTH) {
      state.accumulatedText = (state.accumulatedText + text).slice(0, MAX_ACCUMULATED_TEXT_LENGTH);
    }

    return [
      ...this.completeActiveThinking(sessionId),
      {
        serverMessage: {
          type: 'message',
          sessionId,
          role: 'assistant',
          content: text,
        },
      },
    ];
  }

  private handleThoughtChunk(sessionId: string, content: unknown): ParsedMessage[] {
    const text = extractText(content);
    if (!text) return [];

    const state = this.getOrCreateState(sessionId);
    const timestamp = new Date().toISOString();

    if (!state.activeThinkingId) {
      state.activeThinkingId = randomUUID();
      return [{
        serverMessage: {
          type: 'thinking',
          sessionId,
          content: text,
          status: 'streaming',
          thinkingId: state.activeThinkingId,
          timestamp,
        },
      }];
    }

    return [{
      serverMessage: {
        type: 'thinking_update',
        sessionId,
        thinkingId: state.activeThinkingId,
        contentDelta: text,
        status: 'streaming',
        timestamp,
      },
    }];
  }

  private handleToolCallUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const toolUseId = String(update.toolCallId ?? '');
    if (!toolUseId) {
      return [this.buildGenericOpenCodeToolCall(sessionId, update, 'opencode_tool_call_missing_id')];
    }

    const nextToolName = normalizeToolName(update.title ?? update.kind ?? 'Tool');
    const nextToolKind = inferOpenCodeToolKind(nextToolName, update.kind);
    const pendingTool = state.pendingToolCalls.get(toolUseId);
    const toolName = pendingTool?.toolName ?? nextToolName;
    const toolKind = pendingTool?.toolKind ?? nextToolKind;
    const rawToolParams = isRecord(update.rawInput) ? update.rawInput : {};
    const toolParams = Object.keys(rawToolParams).length > 0
      ? rawToolParams
      : pendingTool?.toolParams ?? {};
    const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
    const status = normalizeToolStatus(update.status);
    const output = extractToolOutput(update);
    const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
    const previousTodos = pendingTool?.previousTodos ?? state.lastTodoSnapshots;
    const toolUseResult = synthesizeOpenCodeToolResult(toolKind, toolParams, {
      output,
      rawOutput,
      status,
      startedAtMs: pendingTool?.startedAtMs ?? Date.now(),
      previousTodos,
    });
    const timestamp = new Date().toISOString();

    const boundary = this.completeActiveThinking(sessionId, timestamp);
    const parsed: ParsedMessage = {
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolName,
        ...(toolKind ? { toolKind } : {}),
        toolParams,
        ...(toolDisplay ? { toolDisplay } : {}),
        status,
        ...(output ? { output } : {}),
        ...(status === 'error' && output ? { error: output } : {}),
        ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        toolUseId,
        timestamp,
      },
    };

    if (status === 'running') {
      if (!pendingTool) {
        state.pendingToolCalls.set(toolUseId, {
          toolName,
          ...(toolKind ? { toolKind } : {}),
          toolParams,
          startedAtMs: Date.now(),
          previousTodos,
        });
      } else {
        state.pendingToolCalls.set(toolUseId, {
          ...pendingTool,
          ...(toolKind ? { toolKind } : {}),
          toolParams,
        });
      }

      parsed.sideEffect = {
        type: 'add_pending_tool_call',
        toolUseId,
        toolName,
        ...(toolKind ? { toolKind } : {}),
        toolParams,
        ...(toolDisplay ? { toolDisplay } : {}),
      };
      return [...boundary, parsed];
    }

    state.pendingToolCalls.delete(toolUseId);
    const nextTodos = extractOpenCodeTodos(toolParams, rawOutput);
    if (toolKind === 'todo_update' && hasOpenCodeTodoPayload(toolParams, rawOutput)) {
      state.lastTodoSnapshots = nextTodos;
    }

    return [
      ...boundary,
      parsed,
      {
        serverMessage: null,
        sideEffect: { type: 'remove_pending_tool_call', toolUseId },
      },
      {
        serverMessage: null,
        sideEffect: { type: 'remove_pending_permission_request', toolUseId },
      },
    ];
  }

  private handleUsageUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const used = toNumber(update.usage?.used ?? update.used);
    const size = toNumber(update.usage?.size ?? update.size);
    const cost = toNumber(update.usage?.cost ?? update.cost?.amount ?? update.cost);

    state.latestUsageUpdate = {
      ...(used !== undefined ? { used } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };

    if (used === undefined) {
      return [];
    }

    return [{
      serverMessage: {
        type: 'context_usage',
        sessionId,
        inputTokens: used,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        ...(size !== undefined ? { contextWindowSize: size } : {}),
      },
    }];
  }

  private handleAvailableCommands(sessionId: string, rawCommands: unknown): ParsedMessage[] {
    if (!Array.isArray(rawCommands)) {
      return [];
    }

    const commands = rawCommands
      .filter((command): command is Record<string, unknown> => isRecord(command) && typeof command.name === 'string')
      .map((command) => ({
        name: String(command.name),
        description: typeof command.description === 'string' ? command.description : '',
      }));

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

  private handlePlanUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const rawEntries = Array.isArray(update.entries)
      ? update.entries
      : Array.isArray(update.todos)
        ? update.todos
        : Array.isArray(update.plan)
          ? update.plan
          : undefined;

    if (!rawEntries) {
      return [];
    }

    const entries = normalizeOpenCodeTodos(rawEntries);
    state.lastTodoSnapshots = entries;

    return [
      ...this.completeActiveThinking(sessionId),
      buildOpenCodeSystemInfo(sessionId, 'opencode_plan_update', 'OpenCode plan updated.', {
        entries,
        rawEntries,
      }),
    ];
  }

  private handleCurrentModeUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const currentModeId = toStringValue(update.currentModeId);
    if (!currentModeId) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      buildOpenCodeSystemInfo(sessionId, 'opencode_current_mode_update', 'OpenCode mode updated.', {
        currentModeId,
      }),
      {
        serverMessage: null,
        sideEffect: {
          type: 'update_provider_state',
          providerState: { opencodeCurrentModeId: currentModeId },
        },
      },
    ];
  }

  private handleConfigOptionUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    if (!Array.isArray(update.configOptions)) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      buildOpenCodeSystemInfo(sessionId, 'opencode_config_option_update', 'OpenCode config options updated.', {
        configOptions: update.configOptions,
      }),
    ];
  }

  private handleSessionInfoUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    const title = toOptionalStringOrNull(update.title);
    const updatedAt = toOptionalStringOrNull(update.updatedAt);
    if (title === undefined && updatedAt === undefined) {
      return [];
    }

    const metadata = {
      ...(title !== undefined ? { title } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
    const providerState = {
      ...(title !== undefined ? { opencodeSessionTitle: title } : {}),
      ...(updatedAt !== undefined ? { opencodeSessionUpdatedAt: updatedAt } : {}),
    };

    return [
      ...this.completeActiveThinking(sessionId),
      buildOpenCodeSystemInfo(sessionId, 'opencode_session_info_update', 'OpenCode session info updated.', metadata),
      {
        serverMessage: null,
        sideEffect: {
          type: 'update_provider_state',
          providerState,
        },
      },
    ];
  }

  private handleUnsupportedSessionUpdate(sessionId: string, update: Record<string, any>): ParsedMessage[] {
    if (looksLikeOpenCodeToolUpdate(update)) {
      return [this.buildGenericOpenCodeToolCall(sessionId, update, 'opencode_unsupported_tool_update')];
    }

    if (DISPLAY_ONLY_OPENCODE_SESSION_UPDATES.has(String(update.sessionUpdate ?? ''))) {
      return [];
    }

    return [
      ...this.completeActiveThinking(sessionId),
      buildOpenCodeSystemWarning(
        sessionId,
        'opencode_unsupported_session_update',
        `Unhandled OpenCode session update: ${String(update.sessionUpdate ?? 'unknown')}`,
        { rawPreview: stringifyPreview(update) },
      ),
    ];
  }

  private buildGenericOpenCodeToolCall(
    sessionId: string,
    update: Record<string, any>,
    reason: string,
  ): ParsedMessage {
    const toolUseId = typeof update.toolCallId === 'string' && update.toolCallId.trim()
      ? update.toolCallId.trim()
      : `opencode-tool-${randomUUID()}`;
    const toolName = normalizeToolName(update.title ?? update.kind ?? update.sessionUpdate ?? 'Tool');
    const status = normalizeToolStatus(update.status);
    const rawToolParams = isRecord(update.rawInput) ? update.rawInput : {};
    const output = extractToolOutput(update) ?? stringifyOpenCodeOutput(update.rawOutput);

    return {
      serverMessage: {
        type: 'tool_call',
        sessionId,
        toolName,
        toolParams: {
          reason,
          sessionUpdate: update.sessionUpdate,
          kind: update.kind,
          ...rawToolParams,
        },
        status,
        output: status === 'error' ? undefined : output,
        error: status === 'error' ? output || `${toolName} failed` : undefined,
        toolUseId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private handlePromptCompleted(
    sessionId: string,
    result: Record<string, any>,
    startedAtMs: number,
  ): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const preview = state.accumulatedText.slice(0, 50);
    const hasMore = state.accumulatedText.length > 50;
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const usage = buildCompletedUsage(result.usage, state, durationMs);
    const messages: ParsedMessage[] = [];

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
    }

    messages.push(
      {
        serverMessage: {
          type: 'notification',
          sessionId,
          event: 'completed',
          message: result.stopReason === 'cancelled' ? 'Task cancelled.' : 'Task completed.',
          preview: preview + (hasMore ? '...' : ''),
          ...(usage ? { usage } : {}),
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

    state.accumulatedText = '';
    state.activeThinkingId = null;
    return messages;
  }

  private completeActiveThinking(sessionId: string, timestamp = new Date().toISOString()): ParsedMessage[] {
    const state = this.getOrCreateState(sessionId);
    const thinkingId = state.activeThinkingId;
    if (!thinkingId) return [];

    state.activeThinkingId = null;
    return [{
      serverMessage: {
        type: 'thinking_update',
        sessionId,
        thinkingId,
        contentDelta: '',
        status: 'completed',
        timestamp,
      },
    }];
  }

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = {
        pendingRequests: new Map(),
        pendingToolCalls: new Map(),
        accumulatedText: '',
        activeThinkingId: null,
        latestUsageUpdate: null,
        currentModel: null,
        lastTodoSnapshots: [],
      };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }
}

function normalizeToolStatus(status: unknown): 'running' | 'completed' | 'error' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'running';
  }
}

function inferOpenCodeToolKind(toolName: string, acpKind: unknown): ToolCallKind | undefined {
  const inferred = inferToolCallKindFromToolName(toolName);
  if (inferred) return inferred;

  switch (acpKind) {
    case 'execute':
      return 'shell_command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_edit';
    case 'read':
      return 'file_read';
    case 'search':
      return 'search_grep';
    case 'fetch':
      return 'web_fetch';
    default:
      return undefined;
  }
}

function normalizeToolName(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'Tool';
  switch (raw.toLowerCase()) {
    case 'bash':
      return 'Bash';
    case 'todowrite':
      return 'TodoWrite';
    case 'todoread':
      return 'TodoRead';
    case 'task':
      return 'Task';
    case 'webfetch':
      return 'WebFetch';
    case 'websearch':
      return 'WebSearch';
    case 'apply_patch':
      return 'ApplyPatch';
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'list':
      return 'List';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'think':
      return 'Think';
    case 'switch_mode':
      return 'SwitchMode';
    default:
      break;
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function extractText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(extractContentText).filter(Boolean).join('');
}

function normalizeUserMessageContent(content: unknown): string | ContentBlock[] | undefined {
  const blocks = Array.isArray(content) ? content : [content];
  const convertedBlocks = blocks
    .map(convertOpenCodeContentBlock)
    .filter((block): block is ContentBlock => block !== undefined);

  if (convertedBlocks.length === 0) {
    return undefined;
  }

  const containsStructuredContent = convertedBlocks.some((block) => block.type !== 'text');
  if (!containsStructuredContent) {
    return convertedBlocks
      .map((block) => block.type === 'text' ? block.text : '')
      .join('');
  }

  return convertedBlocks;
}

function convertOpenCodeContentBlock(content: unknown): ContentBlock | undefined {
  if (typeof content === 'string') {
    return content ? { type: 'text', text: content } : undefined;
  }

  if (!isRecord(content)) {
    return undefined;
  }

  if (content.type === 'image') {
    const mediaType = typeof content.mimeType === 'string' ? content.mimeType : '';
    const data = typeof content.data === 'string' ? content.data : '';
    if (isSupportedImageMime(mediaType) && data) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data,
        },
      };
    }
  }

  const text = extractContentText(content);
  if (text) {
    return { type: 'text', text };
  }

  const description = describeOpenCodeAttachment(content);
  return description ? { type: 'text', text: description } : undefined;
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;

  if (content.type === 'resource' && isRecord(content.resource)) {
    if (typeof content.resource.text === 'string') return content.resource.text;
  }

  return describeOpenCodeAttachment(content);
}

function describeOpenCodeAttachment(content: Record<string, any>): string {
  switch (content.type) {
    case 'image': {
      const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'image';
      const uri = typeof content.uri === 'string' ? ` ${content.uri}` : '';
      return `[Image: ${mimeType}${uri}]`;
    }
    case 'audio': {
      const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'audio';
      return `[Audio: ${mimeType}]`;
    }
    case 'resource_link': {
      const name = typeof content.name === 'string' && content.name ? content.name : 'resource';
      const uri = typeof content.uri === 'string' ? ` ${content.uri}` : '';
      return `[Resource: ${name}${uri}]`;
    }
    case 'resource': {
      const resource = isRecord(content.resource) ? content.resource : {};
      const uri = typeof resource.uri === 'string' ? resource.uri : 'resource';
      const mimeType = typeof resource.mimeType === 'string' ? ` ${resource.mimeType}` : '';
      return `[Resource: ${uri}${mimeType}]`;
    }
    default:
      return '';
  }
}

function isSupportedImageMime(value: string): value is ImageContentBlock['source']['media_type'] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp';
}

function buildOpenCodeSystemInfo(
  sessionId: string,
  subtype: string,
  message: string,
  metadata: Record<string, any>,
): ParsedMessage {
  return {
    serverMessage: {
      type: 'system',
      sessionId,
      message,
      severity: 'info',
      subtype,
      metadata,
      timestamp: new Date().toISOString(),
    },
  };
}

function buildOpenCodeSystemWarning(
  sessionId: string,
  subtype: string,
  message: string,
  metadata: Record<string, any>,
): ParsedMessage {
  return {
    serverMessage: {
      type: 'system',
      sessionId,
      message,
      severity: 'warning',
      subtype,
      metadata,
      timestamp: new Date().toISOString(),
    },
  };
}

function looksLikeOpenCodeToolUpdate(update: Record<string, any>): boolean {
  return update.toolCallId !== undefined ||
    update.rawInput !== undefined ||
    update.rawOutput !== undefined ||
    update.kind !== undefined ||
    update.title !== undefined ||
    update.status !== undefined;
}

function extractToolOutput(update: Record<string, any>): string | undefined {
  if (typeof update.rawOutput === 'string') return update.rawOutput;
  if (isRecord(update.rawOutput)) {
    if (typeof update.rawOutput.output === 'string') return update.rawOutput.output;
    if (typeof update.rawOutput.error === 'string') return update.rawOutput.error;
    if (typeof update.rawOutput.text === 'string') return update.rawOutput.text;
  }
  if (Array.isArray(update.content)) {
    const parts = update.content
      .map((part) => {
        if (!isRecord(part)) return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (isRecord(part.content) && typeof part.content.text === 'string') return part.content.text;
        return '';
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }
  return undefined;
}

function stringifyOpenCodeOutput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return stringifyPreview(value);
}

function stringifyPreview(value: unknown, maxLength = 500): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)}...`
    : serialized;
}

function synthesizeOpenCodeToolResult(
  toolKind: ToolCallKind | undefined,
  toolParams: Record<string, any>,
  options: {
    output?: string;
    rawOutput?: Record<string, any>;
    status: 'running' | 'completed' | 'error';
    startedAtMs: number;
    previousTodos: TodoItem[];
  },
): CanonicalToolResultValue | undefined {
  switch (toolKind) {
    case 'todo_update':
      return synthesizeOpenCodeTodoResult(toolParams, options.rawOutput, options.previousTodos);
    case 'subagent_task':
      return synthesizeOpenCodeTaskResult(toolParams, options);
    default:
      return undefined;
  }
}

function synthesizeOpenCodeTodoResult(
  toolParams: Record<string, any>,
  rawOutput: Record<string, any> | undefined,
  previousTodos: TodoItem[],
): CanonicalToolResultValue | undefined {
  const nextTodos = extractOpenCodeTodos(toolParams, rawOutput);
  if (nextTodos.length === 0) return undefined;
  return {
    kind: 'todo_update',
    previous: previousTodos,
    next: nextTodos,
  };
}

function synthesizeOpenCodeTaskResult(
  toolParams: Record<string, any>,
  options: {
    output?: string;
    rawOutput?: Record<string, any>;
    status: 'running' | 'completed' | 'error';
    startedAtMs: number;
  },
): CanonicalToolResultValue | undefined {
  const agentType = toStringValue(toolParams.subagent_type || toolParams.agent || toolParams.agent_type);
  const prompt = toStringValue(toolParams.prompt);
  const description = toStringValue(toolParams.description);
  const model = extractOpenCodeTaskModel(options.rawOutput);

  if (options.status === 'running') {
    if (!agentType && !prompt && !description) return undefined;
    return {
      kind: 'subagent_task',
      phase: 'started',
      agentType: agentType || 'general',
      description,
      prompt,
      ...(model ? { model } : {}),
    };
  }

  const output = options.output ?? '';
  const agentId = extractOpenCodeTaskId(output, options.rawOutput);
  if (!agentId && !output && !agentType && !prompt && !description) return undefined;

  return {
    kind: 'subagent_task',
    phase: 'completed',
    status: options.status === 'error' ? 'failed' : 'completed',
    agentId: agentId || 'opencode-task',
    prompt,
    responseText: extractOpenCodeTaskResultText(output),
    metrics: {
      totalDurationMs: Math.max(0, Date.now() - options.startedAtMs),
      totalTokens: 0,
      totalToolUseCount: 0,
    },
  };
}

function extractOpenCodeTodos(
  toolParams: Record<string, any>,
  rawOutput?: Record<string, any>,
): TodoItem[] {
  const rawTodos = Array.isArray(rawOutput?.metadata?.todos)
      ? rawOutput.metadata.todos
      : Array.isArray(toolParams.todos)
        ? toolParams.todos
        : parseTodosFromOutput(toStringValue(rawOutput?.output));

  return normalizeOpenCodeTodos(rawTodos);
}

function hasOpenCodeTodoPayload(
  toolParams: Record<string, any>,
  rawOutput?: Record<string, any>,
): boolean {
  return Array.isArray(rawOutput?.metadata?.todos) ||
    Array.isArray(toolParams.todos) ||
    typeof rawOutput?.output === 'string';
}

function normalizeOpenCodeTodos(rawTodos: unknown): TodoItem[] {
  if (!Array.isArray(rawTodos)) return [];
  return rawTodos
    .filter((todo): todo is Record<string, unknown> => isRecord(todo))
    .map((todo) => ({
      content: toStringValue(todo.content ?? todo.subject),
      status: normalizeTodoStatus(todo.status),
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
    }))
    .filter((todo) => todo.content.length > 0);
}

function normalizeTodoStatus(status: unknown): TodoItem['status'] {
  switch (status) {
    case 'completed':
    case 'cancelled':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function parseTodosFromOutput(output: string): unknown {
  if (!output.trim()) return [];
  try {
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function extractOpenCodeTaskId(output: string, rawOutput?: Record<string, any>): string {
  const metadataSessionId = rawOutput?.metadata?.sessionId;
  if (typeof metadataSessionId === 'string' && metadataSessionId) return metadataSessionId;

  const match = output.match(/\btask_id:\s*([^\s]+)/i);
  return match?.[1] ?? '';
}

function extractOpenCodeTaskModel(rawOutput?: Record<string, any>): string {
  const model = rawOutput?.metadata?.model;
  if (!isRecord(model)) return '';

  const providerId = toStringValue(model.providerID);
  const modelId = toStringValue(model.modelID);
  if (providerId && modelId) return `${providerId}/${modelId}`;
  return modelId;
}

function extractOpenCodeTaskResultText(output: string): string {
  const match = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
  if (match?.[1]) return match[1].trim();
  return output.trim();
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toOptionalStringOrNull(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  return undefined;
}

function buildCompletedUsage(
  usage: unknown,
  state: SessionState,
  durationMs: number,
):
  | NonNullable<Extract<ParsedMessage['serverMessage'], { type: 'notification' }>['usage']>
  | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  const inputTokens = toNumber(usage.inputTokens) ?? 0;
  const outputTokens = toNumber(usage.outputTokens) ?? 0;
  const cacheReadTokens = toNumber(usage.cachedReadTokens) ?? 0;
  const cacheCreationTokens = toNumber(usage.cachedWriteTokens) ?? 0;
  const contextWindowSize = state.latestUsageUpdate?.size;
  const costUsd = state.latestUsageUpdate?.cost ?? 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    durationMs,
    durationApiMs: 0,
    numTurns: 0,
    costUsd,
    ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
    ...(state.currentModel ? {
      modelUsage: [{
        model: state.currentModel,
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheReadTokens,
        cacheCreationInputTokens: cacheCreationTokens,
        webSearchRequests: 0,
        costUSD: costUsd,
        ...(contextWindowSize !== undefined ? { contextWindow: contextWindowSize } : {}),
      }],
    } : {}),
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const opencodeProtocolParser = new OpenCodeProtocolParser();
