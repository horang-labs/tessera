import { create } from 'zustand';
import type { AgentPromptHistoryItem } from '@/lib/agent-context-summary';
import type { EnhancedMessage, ConnectionStatus, ActiveInteractivePrompt } from '@/types/chat';
import type { AgentContextEvent } from '@/types/agent-context';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';

const STREAM_FLUSH_BASE_MS = 60;
const STREAM_FLUSH_MEDIUM_MS = 110;
const STREAM_FLUSH_BURST_MS = 160;
const STREAM_ACTIVITY_WINDOW_MS = 250;
const STREAM_ACTIVITY_MEDIUM_THRESHOLD = 3;
const STREAM_ACTIVITY_BURST_THRESHOLD = 8;

interface StreamCadenceState {
  chunkCount: number;
  windowStartedAtMs: number;
}

export interface ActiveAssistantText {
  messageId: string;
}

export interface ScrollPositionSnapshot {
  scrollTop: number;
  anchorKey?: string;
  anchorOffset?: number;
  distanceFromBottom?: number;
  isAtBottom?: boolean;
  itemCount?: number;
  tailSignature?: string;
  capturedDuringTurn?: boolean;
}

const streamCadenceBySession = new Map<string, StreamCadenceState>();

function getAdaptiveStreamFlushDelay(sessionId: string): number {
  const now = Date.now();
  const current = streamCadenceBySession.get(sessionId);

  if (!current || now - current.windowStartedAtMs > STREAM_ACTIVITY_WINDOW_MS) {
    streamCadenceBySession.set(sessionId, {
      chunkCount: 1,
      windowStartedAtMs: now,
    });
    return STREAM_FLUSH_BASE_MS;
  }

  current.chunkCount += 1;

  if (current.chunkCount >= STREAM_ACTIVITY_BURST_THRESHOLD) {
    return STREAM_FLUSH_BURST_MS;
  }

  if (current.chunkCount >= STREAM_ACTIVITY_MEDIUM_THRESHOLD) {
    return STREAM_FLUSH_MEDIUM_MS;
  }

  return STREAM_FLUSH_BASE_MS;
}

function clearStreamCadence(sessionId: string): void {
  streamCadenceBySession.delete(sessionId);
}

function updateTurnInFlightMap(
  current: Record<string, boolean>,
  sessionId: string,
  inFlight: boolean,
): Record<string, boolean> {
  if (inFlight) {
    return { ...current, [sessionId]: true };
  }

  const updated = { ...current };
  delete updated[sessionId];
  return updated;
}

function updateActiveAssistantTextMap(
  current: Record<string, ActiveAssistantText>,
  sessionId: string,
  activeText: ActiveAssistantText | null,
): Record<string, ActiveAssistantText> {
  if (activeText) {
    return { ...current, [sessionId]: activeText };
  }

  const updated = { ...current };
  delete updated[sessionId];
  return updated;
}

export interface ChatState {
  // Messages by session
  messages: Map<string, EnhancedMessage[]>;

  // Assistant text blocks currently waiting for text flush, keyed by session.
  // This drives only the inline streaming dots. It is intentionally separate
  // from turnInFlightBySession, which can stay true during thinking/tools.
  activeAssistantTextBySession: Record<string, ActiveAssistantText>;

  // WebSocket connection
  connectionStatus: ConnectionStatus;
  reconnectAttempt: number;

  // Loading state
  isLoading: boolean;

  // Text chunks waiting to be flushed into the visible assistant message.
  assistantTextBuffers: Map<string, string>;
  assistantTextFlushTimers: Map<string, NodeJS.Timeout | null>;

  // Read-only pagination state (for past session viewing)
  readOnlyPagination: Map<string, {
    projectDir: string;
    hasMore: boolean;
    nextBeforeBytes: number;
  }>;

  // Turn lifecycle state. True means the CLI is still processing this session's turn.
  turnInFlightBySession: Record<string, boolean>;

  // 에러 상태 (NEW)
  errors: Map<string, string>; // sessionId → error message

  // Tool output cache (lazy loading)
  /** Cache for lazily-loaded tool outputs: toolUseId -> { output, toolUseResult } */
  toolOutputCache: Map<string, { output: string; toolUseResult?: any; isError: boolean }>;

  // Active interactive prompts (floating bar/panel, separate from message stream)
  activeInteractivePrompt: Map<string, ActiveInteractivePrompt>;

  // Prompt history used by the live Agent Context right panel.
  promptHistory: Map<string, AgentPromptHistoryItem[]>;

  // Tracks sessions whose JSONL history has been fully loaded via loadHistory().
  // Prevents race condition where WebSocket streaming messages create entries in
  // the messages Map before JSONL history is fetched, causing viewSession() to
  // skip the API fetch.
  historyLoaded: Set<string>;

  // Per-session draft input text (preserved across session switches)
  draftInputs: Map<string, string>;

  // Per-session scroll position (preserved across session switches)
  scrollPositions: Map<string, ScrollPositionSnapshot>;

  // Actions
  isHistoryLoaded: (sessionId: string) => boolean;
  setDraftInput: (sessionId: string, text: string) => void;
  getDraftInput: (sessionId: string) => string;
  setScrollPosition: (sessionId: string, position: number | ScrollPositionSnapshot) => void;
  getScrollPosition: (sessionId: string) => ScrollPositionSnapshot | undefined;
  setActiveInteractivePrompt: (sessionId: string, prompt: ActiveInteractivePrompt | null) => void;
  recordPromptHistoryItem: (sessionId: string, item: AgentPromptHistoryItem) => void;
  resolvePromptHistoryItem: (sessionId: string, promptId: string) => void;
  setTurnInFlight: (sessionId: string, inFlight: boolean) => void;
  setTurnsInFlight: (sessionIds: readonly string[]) => void;
  setError: (sessionId: string, message: string) => void;
  clearError: (sessionId: string) => void;
  addMessage: (sessionId: string, message: EnhancedMessage) => void;
  queueAssistantTextChunk: (sessionId: string, content: string) => void;
  flushAndClearAssistantText: (sessionId: string) => void;
  setConnectionStatus: (status: ConnectionStatus, attempt?: number) => void;
  loadHistory: (sessionId: string, messages: EnhancedMessage[]) => void;
  replaceMessages: (sessionId: string, messages: EnhancedMessage[]) => void;
  prependHistory: (sessionId: string, olderMessages: EnhancedMessage[]) => void;
  clearSession: (sessionId: string) => void;
  clearSessionMessages: (sessionId: string) => void;
  resetForReload: (sessionId: string) => void;
  setLoading: (loading: boolean) => void;
  updateToolCall: (sessionId: string, messageId: string, update: {
    status: 'running' | 'completed' | 'error';
    toolName?: string;
    toolKind?: ToolCallKind;
    toolParams?: Record<string, any>;
    toolDisplay?: ToolDisplayMetadata;
    output?: string;
    error?: string;
    toolUseResult?: any;
    agentContext?: AgentContextEvent[];
    hasOutput?: boolean;
  }) => void;
  setReadOnlyPagination: (sessionId: string, pagination: {
    projectDir: string;
    hasMore: boolean;
    nextBeforeBytes: number;
  }) => void;
  setToolOutput: (sessionId: string, toolUseId: string, data: { output: string; toolUseResult?: any; isError: boolean }) => void;
  getToolOutput: (toolUseId: string) => { output: string; toolUseResult?: any; isError: boolean } | undefined;
  updateThinkingMessage: (sessionId: string, thinkingId: string, update: {
    contentDelta?: string;
    status?: 'streaming' | 'completed';
    signature?: string;
    isRedacted?: boolean;
    endTime?: string;
    elapsedMs?: number;
  }) => void;
}

export function isTurnInFlight(state: ChatState, sessionId: string): boolean {
  return Boolean(state.turnInFlightBySession[sessionId]);
}

export function hasAnyTurnInFlight(state: ChatState, sessionIds: readonly string[]): boolean {
  return sessionIds.some((sessionId) => isTurnInFlight(state, sessionId));
}

export function isAwaitingUserPrompt(state: ChatState, sessionId: string): boolean {
  return state.activeInteractivePrompt.has(sessionId);
}

export function hasAnyAwaitingUserPrompt(state: ChatState, sessionIds: readonly string[]): boolean {
  return sessionIds.some((sessionId) => isAwaitingUserPrompt(state, sessionId));
}

export function hasPendingAssistantTextFlush(state: ChatState, sessionId: string): boolean {
  return (
    (state.assistantTextBuffers.get(sessionId)?.length ?? 0) > 0 ||
    Boolean(state.assistantTextFlushTimers.get(sessionId))
  );
}

export function getActiveAssistantTextMessageId(state: ChatState, sessionId: string): string | null {
  return state.activeAssistantTextBySession[sessionId]?.messageId ?? null;
}

export function hasActiveAssistantText(state: ChatState, sessionId: string): boolean {
  return getActiveAssistantTextMessageId(state, sessionId) !== null;
}

export function shouldShowWaitingIndicator(state: ChatState, sessionId: string): boolean {
  return isTurnInFlight(state, sessionId) && !hasPendingAssistantTextFlush(state, sessionId);
}

export const selectIsTurnInFlight = (sessionId: string) =>
  (state: ChatState): boolean => isTurnInFlight(state, sessionId);

export const selectAnyTurnInFlight = (sessionIds: readonly string[]) =>
  (state: ChatState): boolean => hasAnyTurnInFlight(state, sessionIds);

export const selectIsAwaitingUserPrompt = (sessionId: string) =>
  (state: ChatState): boolean => isAwaitingUserPrompt(state, sessionId);

export const selectAnyAwaitingUserPrompt = (sessionIds: readonly string[]) =>
  (state: ChatState): boolean => hasAnyAwaitingUserPrompt(state, sessionIds);

export const selectHasActiveAssistantText = (sessionId: string) =>
  (state: ChatState): boolean => hasActiveAssistantText(state, sessionId);

export const selectActiveAssistantTextMessageId = (sessionId: string) =>
  (state: ChatState): string | null => getActiveAssistantTextMessageId(state, sessionId);

export const selectShouldShowWaitingIndicator = (sessionId: string) =>
  (state: ChatState): boolean => shouldShowWaitingIndicator(state, sessionId);

export const useChatStore = create<ChatState>((set, get) => ({
  messages: new Map(),
  activeAssistantTextBySession: {},
  connectionStatus: 'disconnected',
  reconnectAttempt: 0,
  isLoading: false,
  assistantTextBuffers: new Map(),
  assistantTextFlushTimers: new Map(),
  readOnlyPagination: new Map(),
  turnInFlightBySession: {},
  errors: new Map(),
  toolOutputCache: new Map(),
  activeInteractivePrompt: new Map(),
  promptHistory: new Map(),
  historyLoaded: new Set(),
  draftInputs: new Map(),
  scrollPositions: new Map(),

  isHistoryLoaded: (sessionId) => get().historyLoaded.has(sessionId),

  setDraftInput: (sessionId, text) =>
    set((state) => {
      const updated = new Map(state.draftInputs);
      if (text) {
        updated.set(sessionId, text);
      } else {
        updated.delete(sessionId);
      }
      return { draftInputs: updated };
    }),

  getDraftInput: (sessionId) => get().draftInputs.get(sessionId) || '',

  setScrollPosition: (sessionId, position) =>
    set((state) => {
      const updated = new Map(state.scrollPositions);
      updated.set(
        sessionId,
        typeof position === 'number' ? { scrollTop: position } : position,
      );
      return { scrollPositions: updated };
    }),

  getScrollPosition: (sessionId) => get().scrollPositions.get(sessionId),

  setActiveInteractivePrompt: (sessionId, prompt) =>
    set((state) => {
      const updated = new Map(state.activeInteractivePrompt);
      if (prompt === null) {
        updated.delete(sessionId);
      } else {
        updated.set(sessionId, prompt);
      }
      return { activeInteractivePrompt: updated };
    }),

  recordPromptHistoryItem: (sessionId, item) =>
    set((state) => {
      const sessionItems = state.promptHistory.get(sessionId) || [];
      const existingIndex = sessionItems.findIndex((current) => current.id === item.id);
      const nextItems = existingIndex === -1
        ? [...sessionItems, item]
        : sessionItems.map((current, index) => index === existingIndex ? { ...current, ...item } : current);
      const updated = new Map(state.promptHistory);
      updated.set(sessionId, nextItems);
      return { promptHistory: updated };
    }),

  resolvePromptHistoryItem: (sessionId, promptId) =>
    set((state) => {
      const sessionItems = state.promptHistory.get(sessionId);
      if (!sessionItems?.some((item) => item.id === promptId && item.status === 'active')) {
        return state;
      }

      const updated = new Map(state.promptHistory);
      updated.set(
        sessionId,
        sessionItems.map((item) =>
          item.id === promptId ? { ...item, status: 'resolved' as const } : item,
        ),
      );
      return { promptHistory: updated };
    }),

  setTurnInFlight: (sessionId, inFlight) => {
    const current = isTurnInFlight(get(), sessionId);
    if (current === inFlight) return;
    set((state) => ({
      turnInFlightBySession: updateTurnInFlightMap(
        state.turnInFlightBySession,
        sessionId,
        inFlight,
      ),
    }));
  },

  setTurnsInFlight: (sessionIds) => {
    const uniqueSessionIds = [...new Set(sessionIds)].filter(Boolean);
    if (uniqueSessionIds.length === 0) return;

    set((state) => {
      let changed = false;
      const next = { ...state.turnInFlightBySession };

      for (const sessionId of uniqueSessionIds) {
        if (next[sessionId]) continue;
        next[sessionId] = true;
        changed = true;
      }

      return changed ? { turnInFlightBySession: next } : state;
    });
  },

  setError: (sessionId, message) =>
    set((state) => {
      const newErrors = new Map(state.errors);
      newErrors.set(sessionId, message);
      return { errors: newErrors };
    }),

  clearError: (sessionId) =>
    set((state) => {
      const newErrors = new Map(state.errors);
      newErrors.delete(sessionId);
      return { errors: newErrors };
    }),

  addMessage: (sessionId, message) =>
    set((state) => {
      const sessionMessages = state.messages.get(sessionId) || [];
      const updatedMessages = new Map(state.messages);
      updatedMessages.set(sessionId, [...sessionMessages, message]);

      return { messages: updatedMessages };
    }),

  queueAssistantTextChunk: (sessionId, content) => {
    const state = get();
    const currentBuffer = state.assistantTextBuffers.get(sessionId) || '';
    const newBuffer = currentBuffer + content;
    const flushDelayMs = getAdaptiveStreamFlushDelay(sessionId);
    const sessionMessages = state.messages.get(sessionId) || [];
    const lastMessage = sessionMessages[sessionMessages.length - 1];
    const isAssistantTextMessage = lastMessage &&
      'type' in lastMessage &&
      lastMessage.type === 'text' &&
      lastMessage.role === 'assistant';

    // Update buffer immediately
    const updatedBuffers = new Map(state.assistantTextBuffers);
    updatedBuffers.set(sessionId, newBuffer);
    set({
      assistantTextBuffers: updatedBuffers,
      activeAssistantTextBySession: isAssistantTextMessage
        ? updateActiveAssistantTextMap(
            state.activeAssistantTextBySession,
            sessionId,
            { messageId: lastMessage.id },
          )
        : updateActiveAssistantTextMap(
            state.activeAssistantTextBySession,
            sessionId,
            null,
          ),
    });

    const existingTimer = state.assistantTextFlushTimers.get(sessionId);
    if (existingTimer) return; // Already scheduled

    const timer = setTimeout(() => {
      const currentState = get();
      const buffer = currentState.assistantTextBuffers.get(sessionId) || '';

      set((state) => {
        const sessionMessages = state.messages.get(sessionId) || [];
        const lastMessage = sessionMessages[sessionMessages.length - 1];

        const isAssistantTextMessage = lastMessage &&
          'type' in lastMessage &&
          lastMessage.type === 'text' &&
          lastMessage.role === 'assistant';
        if (isAssistantTextMessage) {
          // assistant 스트리밍 메시지의 content는 항상 string이다.
          // TextMessage.content 타입 확장(string | ContentBlock[])으로 인한 컴파일 오류 방지.
          const currentContent = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : '';
          // Update last message
          const updatedMessages = [...sessionMessages];
          updatedMessages[updatedMessages.length - 1] = {
            ...lastMessage,
            content: currentContent + buffer,
          };

          const messages = new Map(state.messages);
          messages.set(sessionId, updatedMessages);

          // Clear buffer and timer for this session
          const clearedBuffers = new Map(state.assistantTextBuffers);
          clearedBuffers.set(sessionId, '');
          const clearedTimers = new Map(state.assistantTextFlushTimers);
          clearedTimers.set(sessionId, null);

          return {
            messages,
            assistantTextBuffers: clearedBuffers,
            assistantTextFlushTimers: clearedTimers,
            activeAssistantTextBySession: updateActiveAssistantTextMap(
              state.activeAssistantTextBySession,
              sessionId,
              null,
            ),
          };
        }

        // Clear buffer and timer even if no message
        const clearedBuffers = new Map(state.assistantTextBuffers);
        clearedBuffers.set(sessionId, '');
        const clearedTimers = new Map(state.assistantTextFlushTimers);
        clearedTimers.set(sessionId, null);

        return {
          assistantTextBuffers: clearedBuffers,
          assistantTextFlushTimers: clearedTimers,
          activeAssistantTextBySession: updateActiveAssistantTextMap(
            state.activeAssistantTextBySession,
            sessionId,
            null,
          ),
        };
      });
    }, flushDelayMs);

    // Store timer
    const updatedTimers = new Map(state.assistantTextFlushTimers);
    updatedTimers.set(sessionId, timer);
    set({ assistantTextFlushTimers: updatedTimers });
  },

  flushAndClearAssistantText: (sessionId) => {
    const state = get();

    // Clear timer if exists
    const timer = state.assistantTextFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
    }
    clearStreamCadence(sessionId);

    set((state) => {
      // Flush remaining buffer content before clearing
      const remainingBuffer = state.assistantTextBuffers.get(sessionId) || '';
      let updatedMsgs = state.messages;

      if (remainingBuffer) {
        const sessionMessages = state.messages.get(sessionId) || [];
        const lastMessage = sessionMessages[sessionMessages.length - 1];
        const isAssistantTextMessage = lastMessage &&
          'type' in lastMessage &&
          lastMessage.type === 'text' &&
          lastMessage.role === 'assistant';

        if (isAssistantTextMessage) {
          const currentContent = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : '';
          const updated = [...sessionMessages];
          updated[updated.length - 1] = {
            ...lastMessage,
            content: currentContent + remainingBuffer,
          };
          updatedMsgs = new Map(state.messages);
          updatedMsgs.set(sessionId, updated);
        }
      }

      const clearedBuffers = new Map(state.assistantTextBuffers);
      clearedBuffers.delete(sessionId);
      const clearedTimers = new Map(state.assistantTextFlushTimers);
      clearedTimers.delete(sessionId);

      return {
        messages: updatedMsgs,
        activeAssistantTextBySession: updateActiveAssistantTextMap(
          state.activeAssistantTextBySession,
          sessionId,
          null,
        ),
        assistantTextBuffers: clearedBuffers,
        assistantTextFlushTimers: clearedTimers,
      };
    });
  },

  setConnectionStatus: (status, attempt = 0) =>
    set({
      connectionStatus: status,
      reconnectAttempt: attempt,
    }),

  loadHistory: (sessionId, messages) =>
    set((state) => {
      const updatedMessages = new Map(state.messages);
      updatedMessages.set(sessionId, messages);
      const updatedHistoryLoaded = new Set(state.historyLoaded);
      updatedHistoryLoaded.add(sessionId);

      return { messages: updatedMessages, historyLoaded: updatedHistoryLoaded };
    }),

  replaceMessages: (sessionId, messages) =>
    set((state) => {
      const updatedMessages = new Map(state.messages);
      updatedMessages.set(sessionId, messages);
      return { messages: updatedMessages };
    }),

  prependHistory: (sessionId, olderMessages) =>
    set((state) => {
      const current = state.messages.get(sessionId) || [];
      const updatedMessages = new Map(state.messages);
      updatedMessages.set(sessionId, [...olderMessages, ...current]);
      return { messages: updatedMessages };
    }),

  clearSessionMessages: (sessionId) =>
    set((state) => {
      const sessionMessages = state.messages.get(sessionId) || [];
      // Remove optimistic/system messages (temp-* and system-resume-*) added before WebSocket stream
      const filtered = sessionMessages.filter(
        (m) => !m.id.startsWith('temp-') && !m.id.startsWith('system-resume-')
      );
      const updatedMessages = new Map(state.messages);
      updatedMessages.set(sessionId, filtered);
      return { messages: updatedMessages };
    }),

  resetForReload: (sessionId) =>
    set((state) => {
      const updatedMessages = new Map(state.messages);
      updatedMessages.delete(sessionId);
      const updatedHistoryLoaded = new Set(state.historyLoaded);
      updatedHistoryLoaded.delete(sessionId);
      const updatedPagination = new Map(state.readOnlyPagination);
      updatedPagination.delete(sessionId);
      const updatedPromptHistory = new Map(state.promptHistory);
      updatedPromptHistory.delete(sessionId);
      return {
        messages: updatedMessages,
        historyLoaded: updatedHistoryLoaded,
        readOnlyPagination: updatedPagination,
        promptHistory: updatedPromptHistory,
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const updatedMessages = new Map(state.messages);
      updatedMessages.delete(sessionId);

      // Clear timer if exists
      const timer = state.assistantTextFlushTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
      }
      clearStreamCadence(sessionId);

      // Clear session buffer and timer
      const clearedBuffers = new Map(state.assistantTextBuffers);
      clearedBuffers.delete(sessionId);
      const clearedTimers = new Map(state.assistantTextFlushTimers);
      clearedTimers.delete(sessionId);

      const clearedPagination = new Map(state.readOnlyPagination);
      clearedPagination.delete(sessionId);

      const clearedPrompts = new Map(state.activeInteractivePrompt);
      clearedPrompts.delete(sessionId);
      const clearedPromptHistory = new Map(state.promptHistory);
      clearedPromptHistory.delete(sessionId);

      const clearedHistoryLoaded = new Set(state.historyLoaded);
      clearedHistoryLoaded.delete(sessionId);

      const clearedDrafts = new Map(state.draftInputs);
      clearedDrafts.delete(sessionId);

      const clearedScrollPositions = new Map(state.scrollPositions);
      clearedScrollPositions.delete(sessionId);

      return {
        messages: updatedMessages,
        historyLoaded: clearedHistoryLoaded,
        assistantTextBuffers: clearedBuffers,
        assistantTextFlushTimers: clearedTimers,
        activeAssistantTextBySession: updateActiveAssistantTextMap(
          state.activeAssistantTextBySession,
          sessionId,
          null,
        ),
        turnInFlightBySession: updateTurnInFlightMap(
          state.turnInFlightBySession,
          sessionId,
          false,
        ),
        readOnlyPagination: clearedPagination,
        activeInteractivePrompt: clearedPrompts,
        promptHistory: clearedPromptHistory,
        draftInputs: clearedDrafts,
        scrollPositions: clearedScrollPositions,
      };
    }),

  setLoading: (loading) => set({ isLoading: loading }),

  updateToolCall: (sessionId, messageId, update) =>
    set((state) => {
      const sessionMessages = state.messages.get(sessionId) || [];
      const updatedMessages = sessionMessages.map((msg) => {
        if (msg.id === messageId && 'type' in msg && msg.type === 'tool_call') {
          return { ...msg, ...update };
        }
        return msg;
      });
      const messages = new Map(state.messages);
      messages.set(sessionId, updatedMessages);
      return { messages };
    }),

  setReadOnlyPagination: (sessionId, pagination) =>
    set((state) => {
      const updated = new Map(state.readOnlyPagination);
      updated.set(sessionId, pagination);
      return { readOnlyPagination: updated };
    }),

  setToolOutput: (_sessionId, toolUseId, data) =>
    set((state) => {
      // Only update the cache — do NOT touch messages array.
      // Updating messages causes groupedMessages recalculation → getItemSize
      // reference change → VariableSizeList cache reset → scroll jump.
      // ToolCallBlock reads from cache reactively via useChatStore selector.
      const newCache = new Map(state.toolOutputCache);
      newCache.set(toolUseId, data);
      return { toolOutputCache: newCache };
    }),

  getToolOutput: (toolUseId) => {
    return get().toolOutputCache.get(toolUseId);
  },

  updateThinkingMessage: (sessionId, thinkingId, update) =>
    set((state) => {
      const sessionMessages = state.messages.get(sessionId) || [];
      const idx = sessionMessages.findIndex(
        (m) => 'type' in m && m.type === 'thinking' &&
               (m as any).thinkingId === thinkingId
      );
      if (idx === -1) return state;

      const msg = sessionMessages[idx] as any;
      const updatedMsg = {
        ...msg,
        content: update.contentDelta ? msg.content + update.contentDelta : msg.content,
        status: update.status || msg.status,
        signature: update.signature || msg.signature,
        isRedacted: update.isRedacted ?? msg.isRedacted,
        endTime: update.endTime ?? msg.endTime,
        elapsedMs: update.elapsedMs ?? msg.elapsedMs,
      };

      const updatedMessages = [...sessionMessages];
      updatedMessages[idx] = updatedMsg;
      const messages = new Map(state.messages);
      messages.set(sessionId, updatedMessages);
      return { messages };
    }),
}));
