import type {
  ActiveInteractivePrompt,
  EnhancedMessage,
  ProgressHookMessage,
  SystemMessage,
  TextMessage,
  ThinkingMessage,
  ToolCallMessage,
  WorkflowMessage,
} from '@/types/chat';
import type {
  WorkflowAgentEntry,
  WorkflowPhaseEntry,
  TodoItem,
} from '@/types/cli-jsonl-schemas';
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
  /** Latest successful canonical todo snapshot, independent of message pagination. */
  todoSnapshot: TodoItem[];
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
    todoSnapshot: [],
  };
}

function canonicalTodoSnapshot(value: unknown): TodoItem[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.kind !== 'todo_update' || !Array.isArray(result.next)) return null;

  const snapshot: TodoItem[] = [];
  for (const raw of result.next) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const todo = raw as Record<string, unknown>;
    if (
      typeof todo.content !== 'string' ||
      !todo.content.trim() ||
      (todo.status !== 'pending' && todo.status !== 'in_progress' && todo.status !== 'completed') ||
      (todo.activeForm !== undefined && typeof todo.activeForm !== 'string')
    ) {
      return null;
    }
    const activeForm = typeof todo.activeForm === 'string' ? todo.activeForm.trim() : '';
    snapshot.push({
      content: todo.content.trim(),
      status: todo.status,
      ...(activeForm
        ? { activeForm }
        : {}),
    });
  }
  return snapshot;
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

function workflowMessageId(taskId: string): string {
  return `hist-workflow-${taskId}`;
}

function normalizeWorkflowStatus(status?: string): WorkflowMessage['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'killed' || status === 'cancelled' || status === 'error') {
    return 'failed';
  }
  return 'running';
}

/** Merge an incoming entry over an existing one, ignoring undefined fields. */
function mergeDefined<T extends Record<string, any>>(prev: T | undefined, next: T): T {
  if (!prev) return next;
  const merged: Record<string, any> = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}

function upsertWorkflowMessage(
  state: SessionReplayState,
  sessionId: string,
  event: Extract<SessionReplayEvent, { type: 'workflow_event' }>,
): void {
  const id = workflowMessageId(event.taskId);
  const existingIdx = state.messages.findIndex(
    (message) => message.type === 'workflow' && message.id === id,
  );
  const existing = existingIdx !== -1 ? (state.messages[existingIdx] as WorkflowMessage) : undefined;

  // Ignore terminal/update events for unknown runs — nothing to render.
  if (!existing && event.kind !== 'started' && event.kind !== 'progress') {
    return;
  }

  const base: WorkflowMessage = existing ?? {
    id,
    type: 'workflow',
    sessionId,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    workflowName: event.workflowName || 'Workflow',
    description: event.description,
    status: 'running',
    phases: [],
    agents: [],
    logs: [],
    usage: undefined,
    startedAt: event.timestamp,
    timestamp: event.timestamp,
    rev: 0,
  };

  const next: WorkflowMessage = {
    ...base,
    rev: base.rev + 1,
  };

  switch (event.kind) {
    case 'started':
      if (event.workflowName) next.workflowName = event.workflowName;
      if (event.description !== undefined) next.description = event.description;
      if (event.toolUseId !== undefined) next.toolUseId = event.toolUseId;
      break;

    case 'progress': {
      if (event.progress && event.progress.length > 0) {
        const phases = [...next.phases];
        const agents = [...next.agents];
        const logs = [...next.logs];
        for (const entry of event.progress) {
          if (entry.type === 'workflow_phase') {
            const idx = phases.findIndex((p) => p.index === entry.index);
            if (idx === -1) phases.push(entry);
            else phases[idx] = mergeDefined<WorkflowPhaseEntry>(phases[idx], entry);
          } else if (entry.type === 'workflow_agent') {
            const idx = agents.findIndex((a) => a.index === entry.index);
            if (idx === -1) agents.push(entry);
            else agents[idx] = mergeDefined<WorkflowAgentEntry>(agents[idx], entry);
          } else if (entry.type === 'workflow_log') {
            logs.push(entry.message);
          }
        }
        phases.sort((a, b) => a.index - b.index);
        agents.sort((a, b) => a.index - b.index);
        next.phases = phases;
        next.agents = agents;
        next.logs = logs;
      }
      if (event.usage) next.usage = { ...next.usage, ...event.usage };
      break;
    }

    case 'updated':
      if (event.status) next.status = normalizeWorkflowStatus(event.status);
      if (typeof event.endTime === 'number') {
        next.endedAt = new Date(event.endTime).toISOString();
      }
      break;

    case 'notification':
      next.status = normalizeWorkflowStatus(event.status) === 'running'
        ? 'completed'
        : normalizeWorkflowStatus(event.status);
      if (event.outputFile) next.outputFile = event.outputFile;
      if (event.usage) next.usage = { ...next.usage, ...event.usage };
      if (!next.endedAt) next.endedAt = event.timestamp;
      break;
  }

  if (existingIdx !== -1) {
    state.messages[existingIdx] = next;
  } else {
    state.messages.push(next);
  }
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
    todoSnapshot: currentState.todoSnapshot,
  };

  switch (event.type) {
    case 'user_message':
      state.messages.push(
        makeTextMessage(
          event.messageId ?? `hist-user-${state.messages.length}`,
          'user',
          event.content,
          event.timestamp,
        ),
      );
      return state;

    case 'assistant_message':
      if (event.content) {
        state.messages.push(
          makeTextMessage(
            event.messageId ?? `hist-assistant-${state.messages.length}`,
            'assistant',
            event.content,
            event.timestamp,
          ),
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
          makeTextMessage(
            event.messageId ?? `hist-assistant-live-${state.messages.length}`,
            'assistant',
            event.content,
            event.timestamp,
          ),
        );
      }
      return state;
    }

    case 'message_translation': {
      const idx = state.messages.findIndex((message) => message.id === event.targetMessageId);
      if (idx !== -1 && state.messages[idx].type === 'text') {
        const target = state.messages[idx] as TextMessage;
        if (event.status === 'pending') {
          state.messages[idx] = { ...target, translationStatus: 'pending' };
        } else if (event.status === 'error') {
          state.messages[idx] = { ...target, translationStatus: 'error' };
        } else {
          state.messages[idx] = {
            ...target,
            translatedContent: event.content ?? target.translatedContent,
            translationStatus: 'completed',
            translationLang: event.targetLang,
          };
        }
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

    case 'tool_call': {
      if (event.status === 'completed') {
        const snapshot = canonicalTodoSnapshot(event.toolUseResult);
        if (snapshot) state.todoSnapshot = snapshot;
      }
      upsertToolCallMessage(state, sessionId, event, options);
      return state;
    }

    case 'workflow_event':
      upsertWorkflowMessage(state, sessionId, event);
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
