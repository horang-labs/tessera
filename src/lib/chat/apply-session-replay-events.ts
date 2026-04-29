import { v4 as uuidv4 } from 'uuid';
import { useChatStore } from '@/stores/chat-store';
import { useUsageStore } from '@/stores/usage-store';
import {
  applySessionReplayEvent,
  type SessionReplayState,
} from '@/lib/session-replay-reducer';
import type {
  PersistedContextUsage,
  PersistedUsage,
  SessionReplayEvent,
} from '@/lib/session-replay-types';

function derivePersistedUsage(sessionId: string): PersistedUsage | null {
  const usage = useUsageStore.getState().sessionUsage.get(sessionId);
  if (!usage) {
    return null;
  }

  const hasUsage =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0 ||
    usage.durationApiMs > 0 ||
    usage.numTurns > 0 ||
    usage.costUsd > 0;

  if (!hasUsage) {
    return null;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    durationMs: usage.durationApiMs,
    durationApiMs: usage.durationApiMs,
    numTurns: usage.numTurns,
    costUsd: usage.costUsd,
    contextWindowSize: usage.contextWindowSize || undefined,
    maxOutputTokens: usage.maxOutputTokens || undefined,
    modelUsage: usage.modelUsage,
  };
}

function derivePersistedContextUsage(sessionId: string): PersistedContextUsage | null {
  const usage = useUsageStore.getState().sessionUsage.get(sessionId);
  if (!usage?.hasPerCallContextUsage) {
    return null;
  }

  return {
    inputTokens: usage.perCallInputTokens,
    cacheCreationTokens: usage.perCallCacheCreationTokens,
    cacheReadTokens: usage.perCallCacheReadTokens,
    contextWindowSize: usage.contextWindowSize || undefined,
  };
}

function deriveReplayStateFromStores(sessionId: string): SessionReplayState {
  const chatStore = useChatStore.getState();
  const messageMap = chatStore.messages instanceof Map ? chatStore.messages : new Map<string, SessionReplayState['messages']>();
  const assistantTextBufferMap = chatStore.assistantTextBuffers instanceof Map ? chatStore.assistantTextBuffers : new Map<string, string>();
  const interactivePromptMap = chatStore.activeInteractivePrompt instanceof Map
    ? chatStore.activeInteractivePrompt
    : new Map<string, SessionReplayState['activeInteractivePrompt']>();

  const baseMessages = messageMap.get(sessionId) || [];
  const pendingAssistantText = assistantTextBufferMap.get(sessionId) || '';
  const messages = [...baseMessages];

  if (pendingAssistantText) {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.type === 'text' && lastMessage.role === 'assistant' && typeof lastMessage.content === 'string') {
      messages[messages.length - 1] = {
        ...lastMessage,
        content: lastMessage.content + pendingAssistantText,
      };
    }
  }

  return {
    messages,
    usage: derivePersistedUsage(sessionId),
    contextUsage: derivePersistedContextUsage(sessionId),
    activeInteractivePrompt: interactivePromptMap.get(sessionId) || null,
  };
}

function appendLastMessageIfPresent(sessionId: string, nextState: SessionReplayState): void {
  const lastMessage = nextState.messages[nextState.messages.length - 1];
  if (lastMessage) {
    useChatStore.getState().addMessage(sessionId, lastMessage);
  }
}

function syncPromptProjection(sessionId: string, nextState: SessionReplayState): void {
  useChatStore.getState().setActiveInteractivePrompt(sessionId, nextState.activeInteractivePrompt);
}

function syncUsageProjection(
  sessionId: string,
  event: Extract<SessionReplayEvent, { type: 'context_usage' | 'usage' }>,
  nextState: SessionReplayState,
): void {
  const usageStore = useUsageStore.getState();

  if (event.type === 'context_usage' && nextState.contextUsage) {
    usageStore.updateContextUsage(sessionId, {
      inputTokens: nextState.contextUsage.inputTokens,
      cacheCreationTokens: nextState.contextUsage.cacheCreationTokens,
      cacheReadTokens: nextState.contextUsage.cacheReadTokens,
      contextWindowSize: nextState.contextUsage.contextWindowSize,
    });
    return;
  }

  if (event.type === 'usage' && nextState.usage) {
    usageStore.updateUsage(sessionId, {
      inputTokens: nextState.usage.inputTokens,
      outputTokens: nextState.usage.outputTokens,
      cacheReadTokens: nextState.usage.cacheReadTokens,
      cacheCreationTokens: nextState.usage.cacheCreationTokens,
      contextWindowSize: nextState.usage.contextWindowSize,
      maxOutputTokens: nextState.usage.maxOutputTokens,
      durationApiMs: nextState.usage.durationApiMs,
      costUsd: nextState.usage.costUsd,
      numTurns: nextState.usage.numTurns,
      modelUsage: nextState.usage.modelUsage,
    });
  }
}

function projectReplayStateTransition(
  sessionId: string,
  prevState: SessionReplayState,
  nextState: SessionReplayState,
  event: SessionReplayEvent,
): void {
  const chatStore = useChatStore.getState();

  switch (event.type) {
    case 'user_message':
    case 'assistant_message':
    case 'thinking':
    case 'system':
    case 'progress_hook':
      if (nextState.messages.length > prevState.messages.length) {
        appendLastMessageIfPresent(sessionId, nextState);
      }
      if (event.type === 'assistant_message') {
        syncPromptProjection(sessionId, nextState);
      }
      return;

    case 'assistant_message_chunk': {
      const currentMessages = chatStore.messages.get(sessionId) || [];
      const lastMessage = currentMessages[currentMessages.length - 1];
      const isAssistantText = lastMessage &&
        'role' in lastMessage &&
        lastMessage.role === 'assistant' &&
        'type' in lastMessage &&
        lastMessage.type === 'text';

      if (isAssistantText) {
        chatStore.queueAssistantTextChunk(sessionId, event.content);
      } else {
        chatStore.addMessage(sessionId, {
          id: uuidv4(),
          type: 'text',
          role: 'assistant',
          content: '',
          timestamp: event.timestamp,
        });
        chatStore.queueAssistantTextChunk(sessionId, event.content);
      }
      return;
    }

    case 'thinking_start':
      if (nextState.messages.length > prevState.messages.length) {
        appendLastMessageIfPresent(sessionId, nextState);
      }
      return;

    case 'thinking_delta': {
      const prevLast = prevState.messages[prevState.messages.length - 1];
      const nextLast = nextState.messages[nextState.messages.length - 1];

      if (nextState.messages.length > prevState.messages.length) {
        appendLastMessageIfPresent(sessionId, nextState);
        return;
      }

      if (
        prevLast?.type === 'thinking' &&
        nextLast?.type === 'thinking' &&
        nextLast.thinkingId &&
        nextLast.id === prevLast.id
      ) {
        const prevContent = prevLast.content;
        const nextContent = nextLast.content;
        chatStore.updateThinkingMessage(sessionId, nextLast.thinkingId, {
          contentDelta: nextContent.startsWith(prevContent)
            ? nextContent.slice(prevContent.length)
            : event.contentDelta,
          status: nextLast.status,
          signature: nextLast.signature,
          isRedacted: nextLast.isRedacted,
          endTime: nextLast.endTime,
          elapsedMs: nextLast.elapsedMs,
        });
        return;
      }

      chatStore.replaceMessages(sessionId, nextState.messages);
      return;
    }

    case 'tool_call': {
      if (nextState.messages.length > prevState.messages.length) {
        appendLastMessageIfPresent(sessionId, nextState);
        return;
      }

      const nextTool = nextState.messages.find(
        (message) => message.type === 'tool_call' &&
          ((event.toolUseId && message.id === `hist-tool-${event.toolUseId}`) ||
            (!event.toolUseId && message.toolName === event.toolName)),
      );

      if (nextTool?.type === 'tool_call') {
        const existingMessages = chatStore.messages.get(sessionId) || [];
        const existingToolCall = event.toolUseId
          ? existingMessages.find(
              (message) => message.type === 'tool_call' && message.id.endsWith(`-tool-${event.toolUseId}`),
            )
          : [...existingMessages].reverse().find(
              (message) => message.type === 'tool_call' &&
                message.toolName === event.toolName &&
                message.status === 'running',
            );

        if (existingToolCall) {
          chatStore.updateToolCall(sessionId, existingToolCall.id, {
            toolKind: nextTool.toolKind,
            status: nextTool.status,
            output: nextTool.output,
            error: nextTool.error,
            toolUseResult: nextTool.toolUseResult,
            hasOutput: nextTool.hasOutput,
          });
          return;
        }
      }

      chatStore.replaceMessages(sessionId, nextState.messages);
      return;
    }

    case 'interactive_prompt':
    case 'interactive_prompt_response':
    case 'interactive_prompt_cleared':
      syncPromptProjection(sessionId, nextState);
      return;

    case 'context_usage':
    case 'usage':
      syncUsageProjection(sessionId, event, nextState);
      return;
  }
}

export function applySessionReplayEventsToStores(
  sessionId: string,
  events: SessionReplayEvent[],
): void {
  if (events.length === 0) {
    return;
  }

  let replayState = deriveReplayStateFromStores(sessionId);
  for (const event of events) {
    const nextState = applySessionReplayEvent(sessionId, replayState, event, { lazyToolOutput: false });
    projectReplayStateTransition(sessionId, replayState, nextState, event);
    replayState = nextState;
  }
}

export {
  derivePersistedContextUsage,
  derivePersistedUsage,
  deriveReplayStateFromStores,
};
