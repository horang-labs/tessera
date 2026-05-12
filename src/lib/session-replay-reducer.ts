import type {
  ActiveInteractivePrompt,
  EnhancedMessage,
  ProgressHookMessage,
  SystemMessage,
  TextMessage,
  ThinkingMessage,
  ToolCallMessage,
} from '@/types/chat';
import { isRenderableEnhancedMessage } from '@/lib/chat/renderability';
import type {
  PersistedContextUsage,
  PersistedUsage,
  SessionHistoryEvent,
  SessionReplayEvent,
} from './session-replay-types';

export interface SessionReplayState {
  messages: EnhancedMessage[];
  usage: PersistedUsage | null;
  contextUsage: PersistedContextUsage | null;
  activeInteractivePrompt: ActiveInteractivePrompt | null;
}

function makeTextMessage(
  id: string,
  role: TextMessage['role'],
  content: TextMessage['content'],
  timestamp: string,
): TextMessage {
  return { id, type: 'text', role, content, timestamp };
}

export function createEmptySessionReplayState(): SessionReplayState {
  return {
    messages: [],
    usage: null,
    contextUsage: null,
    activeInteractivePrompt: null,
  };
}

function makeCompletedThinkingMessageId(state: SessionReplayState, thinkingId?: string): string {
  const suffix = state.messages.length;
  return thinkingId ? `hist-thinking-${suffix}-${thinkingId}` : `hist-thinking-${suffix}`;
}

function isValidContextUsageSnapshot(
  usage: PersistedContextUsage,
): boolean {
  if (!usage.contextWindowSize || usage.contextWindowSize <= 0) {
    return true;
  }
  const total = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return total <= usage.contextWindowSize;
}

export function buildActiveInteractivePrompt(
  sessionId: string,
  event: Extract<SessionHistoryEvent, { type: 'interactive_prompt' }>,
): ActiveInteractivePrompt {
  const toolUseId = typeof event.data.toolUseId === 'string' && event.data.toolUseId.length > 0
    ? event.data.toolUseId
    : `hist-prompt-${event.timestamp}`;

  return {
    promptType: event.promptType,
    toolUseId,
    sessionId,
    question: typeof event.data.question === 'string' ? event.data.question : undefined,
    options: Array.isArray(event.data.options) ? event.data.options : undefined,
    questions: Array.isArray(event.data.questions) ? event.data.questions : undefined,
    metadata: event.data.metadata,
    toolName: typeof event.data.toolName === 'string' ? event.data.toolName : undefined,
    toolInput: event.data.toolInput,
    decisionReason: typeof event.data.decisionReason === 'string' ? event.data.decisionReason : undefined,
    agentId: typeof event.data.agentId === 'string' ? event.data.agentId : undefined,
    plan: typeof event.data.plan === 'string' ? event.data.plan : undefined,
    allowedPrompts: Array.isArray(event.data.allowedPrompts) ? event.data.allowedPrompts : undefined,
    planFilePath: typeof event.data.planFilePath === 'string' ? event.data.planFilePath : undefined,
  };
}

function upsertToolCallMessage(
  state: SessionReplayState,
  sessionId: string,
  event: Extract<SessionReplayEvent, { type: 'tool_call' }>,
  options: { lazyToolOutput?: boolean },
): void {
  const hasDeferredOutput = !!(event.output || event.error || event.toolUseResult);
  const output = options.lazyToolOutput && hasDeferredOutput ? undefined : event.output;
  const error = options.lazyToolOutput && hasDeferredOutput ? undefined : event.error;
  const toolUseResult = options.lazyToolOutput && hasDeferredOutput ? undefined : event.toolUseResult;
  const hasOutput = hasDeferredOutput ? true : undefined;

  if (event.toolUseId) {
    const existingIdx = state.messages.findIndex(
      (message) => message.type === 'tool_call' && message.id === `hist-tool-${event.toolUseId}`,
    );

    if (existingIdx !== -1) {
      const prev = state.messages[existingIdx] as ToolCallMessage;
      const mergedToolParams = {
        ...prev.toolParams,
        ...event.toolParams,
      };
      state.messages[existingIdx] = {
        ...prev,
        ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
        toolName: event.toolName || prev.toolName,
        ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
        toolParams: mergedToolParams,
        ...(event.toolDisplay !== undefined ? { toolDisplay: event.toolDisplay } : {}),
        ...(event.agentContext !== undefined ? { agentContext: event.agentContext } : {}),
        status: event.status,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        ...(hasOutput ? { hasOutput } : {}),
        timestamp: event.timestamp,
      };
      return;
    }
  }

  state.messages.push({
    id: event.toolUseId ? `hist-tool-${event.toolUseId}` : `hist-tool-${state.messages.length}`,
    type: 'tool_call',
    sessionId,
    ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
    toolName: event.toolName,
    ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
    toolParams: event.toolParams,
    ...(event.toolDisplay !== undefined ? { toolDisplay: event.toolDisplay } : {}),
    ...(event.agentContext !== undefined ? { agentContext: event.agentContext } : {}),
    status: event.status,
    ...(output !== undefined ? { output } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
    ...(hasOutput ? { hasOutput } : {}),
    timestamp: event.timestamp,
  });
}

function upsertStreamingThinkingMessage(
  state: SessionReplayState,
  sessionId: string,
  event: Extract<SessionReplayEvent, { type: 'thinking_start' | 'thinking_delta' }>,
): void {
  const existingIdx = event.thinkingId
    ? state.messages.findIndex(
        (message) => message.type === 'thinking' && message.thinkingId === event.thinkingId,
      )
    : -1;

  if (existingIdx === -1) {
    const content = event.type === 'thinking_start'
      ? (event.content ?? '')
      : event.contentDelta;

    state.messages.push({
      id: event.thinkingId || `hist-thinking-live-${state.messages.length}`,
      type: 'thinking',
      sessionId,
      content,
      status: event.type === 'thinking_delta' && event.status === 'completed'
        ? 'completed'
        : 'streaming',
      signature: event.signature,
      isRedacted: event.isRedacted,
      thinkingId: event.thinkingId,
      startTime: event.timestamp,
      timestamp: event.timestamp,
      ...(event.type === 'thinking_delta' && event.status === 'completed'
        ? { endTime: event.timestamp, elapsedMs: 0 }
        : {}),
    });
    return;
  }

  const prev = state.messages[existingIdx] as ThinkingMessage;
  state.messages[existingIdx] = {
    ...prev,
    content: event.type === 'thinking_start'
      ? (event.content ?? prev.content)
      : prev.content + event.contentDelta,
    signature: event.signature ?? prev.signature,
    isRedacted: event.isRedacted ?? prev.isRedacted,
    status: event.type === 'thinking_delta' && event.status === 'completed' ? 'completed' : prev.status,
    ...(event.type === 'thinking_delta' && event.status === 'completed'
      ? {
          endTime: event.timestamp,
          elapsedMs: prev.startTime
            ? Math.max(0, new Date(event.timestamp).getTime() - new Date(prev.startTime).getTime())
            : prev.elapsedMs,
        }
      : {}),
    timestamp: prev.timestamp || event.timestamp,
  };
}

export function applySessionReplayEvent(
  sessionId: string,
  currentState: SessionReplayState,
  event: SessionReplayEvent,
  options: { lazyToolOutput?: boolean } = {},
): SessionReplayState {
  const state: SessionReplayState = {
    messages: [...currentState.messages],
    usage: currentState.usage,
    contextUsage: currentState.contextUsage,
    activeInteractivePrompt: currentState.activeInteractivePrompt,
  };

  switch (event.type) {
    case 'user_message':
      state.messages.push(
        makeTextMessage(`hist-user-${state.messages.length}`, 'user', event.content, event.timestamp),
      );
      return state;

    case 'assistant_message':
      if (event.content) {
        state.messages.push(
          makeTextMessage(`hist-assistant-${state.messages.length}`, 'assistant', event.content, event.timestamp),
        );
      }
      state.activeInteractivePrompt = null;
      return state;

    case 'assistant_message_chunk': {
      const lastMessage = state.messages[state.messages.length - 1];
      if (lastMessage?.type === 'text' && lastMessage.role === 'assistant' && typeof lastMessage.content === 'string') {
        state.messages[state.messages.length - 1] = {
          ...lastMessage,
          content: lastMessage.content + event.content,
        };
      } else {
        state.messages.push(
          makeTextMessage(`hist-assistant-live-${state.messages.length}`, 'assistant', event.content, event.timestamp),
        );
      }
      return state;
    }

    case 'thinking':
      state.messages.push({
        id: makeCompletedThinkingMessageId(state, event.thinkingId),
        type: 'thinking',
        sessionId,
        content: event.content,
        status: 'completed',
        signature: event.signature,
        isRedacted: event.isRedacted,
        thinkingId: event.thinkingId,
        startTime: event.startTime,
        endTime: event.endTime,
        elapsedMs: event.elapsedMs,
        timestamp: event.timestamp,
      });
      return state;

    case 'thinking_start':
    case 'thinking_delta':
      upsertStreamingThinkingMessage(state, sessionId, event);
      return state;

    case 'system': {
      const message: SystemMessage = {
        id: `hist-system-${state.messages.length}`,
        type: 'system',
        sessionId,
        message: event.message,
        severity: event.severity,
        subtype: event.subtype,
        metadata: event.metadata,
        timestamp: event.timestamp,
      };
      if (isRenderableEnhancedMessage(message)) {
        state.messages.push(message);
      }
      return state;
    }

    case 'progress_hook': {
      const message: ProgressHookMessage = {
        id: `hist-progress-${state.messages.length}`,
        type: 'progress_hook',
        sessionId,
        hookEvent: event.hookEvent,
        data: event.data,
        progressType: event.progressType,
        timestamp: event.timestamp,
      };
      if (isRenderableEnhancedMessage(message)) {
        state.messages.push(message);
      }
      return state;
    }

    case 'tool_call':
      upsertToolCallMessage(state, sessionId, event, options);
      return state;

    case 'interactive_prompt':
      state.activeInteractivePrompt = buildActiveInteractivePrompt(sessionId, event);
      return state;

    case 'interactive_prompt_response':
      if (!state.activeInteractivePrompt || state.activeInteractivePrompt.toolUseId === event.toolUseId) {
        state.activeInteractivePrompt = null;
      }
      return state;

    case 'interactive_prompt_cleared':
      if (!event.toolUseId || state.activeInteractivePrompt?.toolUseId === event.toolUseId) {
        state.activeInteractivePrompt = null;
      }
      return state;

    case 'context_usage':
      {
        const nextContextUsage = {
          inputTokens: event.inputTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          cacheReadTokens: event.cacheReadTokens,
          contextWindowSize: event.contextWindowSize,
        };
        if (isValidContextUsageSnapshot(nextContextUsage)) {
          state.contextUsage = nextContextUsage;
        }
      }
      return state;

    case 'usage':
      state.usage = event.usage;
      return state;

    default:
      return state;
  }
}

export function reduceSessionReplayEvents(
  sessionId: string,
  events: SessionReplayEvent[],
  options: { lazyToolOutput?: boolean } = {},
): SessionReplayState {
  let state = createEmptySessionReplayState();
  for (const event of events) {
    state = applySessionReplayEvent(sessionId, state, event, options);
  }
  return state;
}
