import fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import type { ContentBlock, ServerMessage, ServerTransportMessage } from './ws/message-types';
import type { EnhancedMessage } from '@/types/chat';
import { groupMessages } from '@/lib/chat/group-messages';
import {
  reduceSessionReplayEvents,
  type SessionReplayState,
} from './session-replay-reducer';
import type {
  PersistedContextUsage,
  PersistedUsage,
  SessionHistoryEvent,
  SessionReplayEvent,
} from './session-replay-types';
import logger from './logger';
import { getTesseraDataPath } from './tessera-data-dir';

const HISTORY_DIR = getTesseraDataPath('session-history');
const HISTORY_VERSION = 1;

interface PendingThinkingState {
  timestamp: string;
  thinkingId?: string;
  content: string;
  signature?: string;
  isRedacted?: boolean;
  startTime?: string;
}

interface SessionBufferState {
  assistantTimestamp?: string;
  assistantContent: string;
  thinking?: PendingThinkingState;
}

interface SessionHistoryPage {
  messages: EnhancedMessage[];
  usage: PersistedUsage | null;
  contextUsage: PersistedContextUsage | null;
  activeInteractivePrompt: SessionReplayState['activeInteractivePrompt'];
  hasMore: boolean;
  nextBeforeBytes: number;
}

type SessionHistoryReplayState = SessionReplayState;

interface ReadHistoryOptions {
  limit?: number;
  beforeBytes?: number;
  lazyToolOutput?: boolean;
}

interface PaginatedReplayMessages {
  messages: EnhancedMessage[];
  hasMore: boolean;
  nextBeforeBytes: number;
}

function ensureHistoryDir(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
}

function parseHistoryEvent(line: string): SessionHistoryEvent | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as SessionHistoryEvent;
  } catch {
    return null;
  }
}

class SessionHistoryStore {
  private buffers = new Map<string, SessionBufferState>();

  getHistoryPath(sessionId: string): string {
    return path.join(HISTORY_DIR, `${sessionId}.jsonl`);
  }

  async historyExists(sessionId: string): Promise<boolean> {
    try {
      await fsp.access(this.getHistoryPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  recordUserMessage(sessionId: string, content: string | ContentBlock[], timestamp = new Date().toISOString()): void {
    this.flushBufferedContent(sessionId);
    this.appendEvent(sessionId, {
      v: HISTORY_VERSION,
      type: 'user_message',
      timestamp,
      content,
    });
  }

  recordTransportMessage(message: ServerTransportMessage | ServerMessage): void {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'replay_events') {
      this.recordReplayEvents(message.sessionId, message.events);
      return;
    }

    if ('sessionId' in message && typeof message.sessionId === 'string') {
      this.recordServerMessage(message.sessionId, message);
    }
  }

  recordServerMessage(sessionId: string, message: ServerMessage | Record<string, any>): void {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'user_message':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, {
          v: HISTORY_VERSION,
          type: 'user_message',
          timestamp: message.timestamp || new Date().toISOString(),
          content: message.content,
        });
        return;

      case 'message': {
        if (message.role !== 'assistant' || typeof message.content !== 'string') {
          return;
        }

        const state = this.getOrCreateBuffer(sessionId);
        state.assistantTimestamp ||= new Date().toISOString();
        state.assistantContent += message.content;
        return;
      }

      case 'thinking': {
        this.flushAssistant(sessionId);
        const state = this.getOrCreateBuffer(sessionId);
        if (state.thinking && state.thinking.content.trim()) {
          this.flushThinking(sessionId);
        }
        state.thinking = {
          timestamp: message.timestamp || new Date().toISOString(),
          thinkingId: message.thinkingId,
          content: message.content || '',
          signature: message.signature,
          isRedacted: message.isRedacted,
          startTime: message.timestamp || new Date().toISOString(),
        };
        if (message.status === 'completed') {
          this.flushThinking(sessionId);
        }
        return;
      }

      case 'thinking_update': {
        const state = this.getOrCreateBuffer(sessionId);
        if (!state.thinking) {
          state.thinking = {
            timestamp: message.timestamp || new Date().toISOString(),
            thinkingId: message.thinkingId,
            content: '',
            startTime: message.timestamp || new Date().toISOString(),
          };
        }

        state.thinking.content += message.contentDelta || '';
        if (message.signature) {
          state.thinking.signature = message.signature;
        }
        if (message.isRedacted != null) {
          state.thinking.isRedacted = message.isRedacted;
        }

        if (message.status === 'completed') {
          this.flushThinking(sessionId, message.timestamp || new Date().toISOString());
        }
        return;
      }

      case 'tool_call':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, {
          v: HISTORY_VERSION,
          type: 'tool_call',
          timestamp: message.timestamp || new Date().toISOString(),
          toolName: message.toolName,
          toolKind: message.toolKind,
          toolParams: message.toolParams,
          toolDisplay: message.toolDisplay,
          status: message.status,
          output: message.output,
          error: message.error,
          toolUseResult: message.toolUseResult,
          agentContext: message.agentContext,
          toolUseId: message.toolUseId,
        });
        return;

      case 'system':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, {
          v: HISTORY_VERSION,
          type: 'system',
          timestamp: message.timestamp || new Date().toISOString(),
          message: message.message,
          severity: message.severity,
          subtype: message.subtype,
          metadata: message.metadata,
        });
        return;

      case 'progress_hook':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, {
          v: HISTORY_VERSION,
          type: 'progress_hook',
          timestamp: message.timestamp || new Date().toISOString(),
          hookEvent: message.hookEvent,
          data: message.data,
          progressType: message.progressType,
        });
        return;

      case 'interactive_prompt':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, {
          v: HISTORY_VERSION,
          type: 'interactive_prompt',
          timestamp: new Date().toISOString(),
          promptType: message.promptType,
          data: message.data,
        });
        return;

      case 'context_usage':
        this.appendEvent(sessionId, {
          v: HISTORY_VERSION,
          type: 'context_usage',
          timestamp: new Date().toISOString(),
          inputTokens: message.inputTokens,
          cacheCreationTokens: message.cacheCreationTokens,
          cacheReadTokens: message.cacheReadTokens,
          contextWindowSize: message.contextWindowSize,
        });
        return;

      case 'notification':
        this.flushBufferedContent(sessionId);
        if (message.usage) {
          this.appendEvent(sessionId, {
            v: HISTORY_VERSION,
            type: 'usage',
            timestamp: new Date().toISOString(),
            usage: message.usage,
          });
        }
        return;

      case 'cli_down':
        this.flushBufferedContent(sessionId);
        return;

      default:
        return;
    }
  }

  recordReplayEvents(sessionId: string, events: SessionReplayEvent[]): void {
    for (const event of events) {
      this.recordReplayEvent(sessionId, event);
    }
  }

  recordInteractivePromptResponse(
    sessionId: string,
    toolUseId: string,
    response: string,
    timestamp = new Date().toISOString(),
  ): void {
    this.flushBufferedContent(sessionId);
    this.appendEvent(sessionId, {
      v: HISTORY_VERSION,
      type: 'interactive_prompt_response',
      timestamp,
      toolUseId,
      response,
    });
  }

  flushSession(sessionId: string): void {
    this.flushBufferedContent(sessionId);
  }

  async readSession(sessionId: string, options: ReadHistoryOptions = {}): Promise<SessionHistoryPage> {
    this.flushSession(sessionId);

    const events = await this.readEvents(sessionId);
    const replayState = reduceHistoryEventsToReplayState(sessionId, events, {
      lazyToolOutput: options.lazyToolOutput ?? true,
    });

    const { messages, hasMore, nextBeforeBytes } = paginateReplayMessages(
      replayState.messages,
      {
        limit: options.limit ?? 100,
        beforeBytes: options.beforeBytes,
      },
    );

    return {
      ...replayState,
      messages,
      hasMore,
      nextBeforeBytes,
    };
  }

  async readReplayState(
    sessionId: string,
    options: { lazyToolOutput?: boolean } = {},
  ): Promise<SessionHistoryReplayState> {
    this.flushSession(sessionId);
    const events = await this.readEvents(sessionId);
    return reduceHistoryEventsToReplayState(sessionId, events, options);
  }

  async readAllMessages(sessionId: string): Promise<EnhancedMessage[]> {
    const replayState = await this.readReplayState(sessionId, { lazyToolOutput: false });
    return replayState.messages;
  }

  async readToolOutput(sessionId: string, toolUseId: string): Promise<{ output: string; toolUseResult?: any; isError: boolean } | null> {
    this.flushSession(sessionId);
    const events = await this.readEvents(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== 'tool_call' || event.toolUseId !== toolUseId) {
        continue;
      }

      if (event.status === 'completed' || event.status === 'error') {
        return {
          output: event.status === 'error' ? (event.error ?? '') : (event.output ?? ''),
          toolUseResult: event.toolUseResult,
          isError: event.status === 'error',
        };
      }
    }

    return null;
  }

  async readUsage(sessionId: string): Promise<PersistedUsage | null> {
    const replayState = await this.readReplayState(sessionId, { lazyToolOutput: true });
    return replayState.usage;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.buffers.delete(sessionId);
    try {
      await fsp.unlink(this.getHistoryPath(sessionId));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  private getOrCreateBuffer(sessionId: string): SessionBufferState {
    let state = this.buffers.get(sessionId);
    if (!state) {
      state = { assistantContent: '' };
      this.buffers.set(sessionId, state);
    }
    return state;
  }

  private flushBufferedContent(sessionId: string): void {
    this.flushThinking(sessionId);
    this.flushAssistant(sessionId);
  }

  private flushAssistant(sessionId: string): void {
    const state = this.buffers.get(sessionId);
    if (!state || !state.assistantContent) {
      return;
    }

    this.appendEvent(sessionId, {
      v: HISTORY_VERSION,
      type: 'assistant_message',
      timestamp: state.assistantTimestamp || new Date().toISOString(),
      content: state.assistantContent,
    });

    state.assistantContent = '';
    state.assistantTimestamp = undefined;
  }

  private flushThinking(sessionId: string, endTime?: string): void {
    const state = this.buffers.get(sessionId);
    if (!state?.thinking) {
      return;
    }

    const thinking = state.thinking;
    if (!thinking.content && !thinking.isRedacted) {
      state.thinking = undefined;
      return;
    }

    const finalEndTime = endTime || new Date().toISOString();
    const startMs = thinking.startTime ? new Date(thinking.startTime).getTime() : NaN;
    const endMs = new Date(finalEndTime).getTime();

    this.appendEvent(sessionId, {
      v: HISTORY_VERSION,
      type: 'thinking',
      timestamp: thinking.timestamp,
      content: thinking.content,
      signature: thinking.signature,
      isRedacted: thinking.isRedacted,
      thinkingId: thinking.thinkingId,
      startTime: thinking.startTime,
      endTime: finalEndTime,
      elapsedMs: Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : undefined,
    });

    state.thinking = undefined;
  }

  private recordReplayEvent(sessionId: string, event: SessionReplayEvent): void {
    switch (event.type) {
      case 'user_message':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, event);
        return;

      case 'assistant_message':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, event);
        return;

      case 'assistant_message_chunk': {
        const state = this.getOrCreateBuffer(sessionId);
        state.assistantTimestamp ||= event.timestamp || new Date().toISOString();
        state.assistantContent += event.content;
        return;
      }

      case 'thinking_start': {
        this.flushAssistant(sessionId);
        const state = this.getOrCreateBuffer(sessionId);
        if (state.thinking && state.thinking.content.trim()) {
          this.flushThinking(sessionId);
        }
        state.thinking = {
          timestamp: event.timestamp || new Date().toISOString(),
          thinkingId: event.thinkingId,
          content: event.content || '',
          signature: event.signature,
          isRedacted: event.isRedacted,
          startTime: event.timestamp || new Date().toISOString(),
        };
        return;
      }

      case 'thinking_delta': {
        const state = this.getOrCreateBuffer(sessionId);
        if (!state.thinking) {
          state.thinking = {
            timestamp: event.timestamp || new Date().toISOString(),
            thinkingId: event.thinkingId,
            content: '',
            startTime: event.timestamp || new Date().toISOString(),
          };
        }
        state.thinking.content += event.contentDelta || '';
        if (event.signature) {
          state.thinking.signature = event.signature;
        }
        if (event.status === 'completed') {
          this.flushThinking(sessionId, event.timestamp || new Date().toISOString());
        }
        return;
      }

      case 'thinking':
        this.flushAssistant(sessionId);
        if (this.getOrCreateBuffer(sessionId).thinking) {
          this.flushThinking(sessionId);
        }
        this.appendEvent(sessionId, event);
        return;

      case 'tool_call':
      case 'system':
      case 'progress_hook':
      case 'interactive_prompt':
      case 'interactive_prompt_response':
        this.flushBufferedContent(sessionId);
        this.appendEvent(sessionId, event);
        return;

      case 'context_usage':
      case 'usage':
        this.appendEvent(sessionId, event);
        return;

      case 'interactive_prompt_cleared':
        this.flushBufferedContent(sessionId);
        return;

      default:
        return;
    }
  }

  private appendEvent(sessionId: string, event: SessionHistoryEvent): void {
    ensureHistoryDir();
    const filePath = this.getHistoryPath(sessionId);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
  }

  async readEvents(sessionId: string): Promise<SessionHistoryEvent[]> {
    const filePath = this.getHistoryPath(sessionId);
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map(parseHistoryEvent)
        .filter((event): event is SessionHistoryEvent => event !== null);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return [];
      }
      logger.error({ sessionId, error: err?.message || String(err) }, 'Failed to read session history');
      throw err;
    }
  }
}

function reduceHistoryEventsToReplayState(
  sessionId: string,
  events: SessionHistoryEvent[],
  options: { lazyToolOutput?: boolean } = {},
): SessionHistoryReplayState {
  return reduceSessionReplayEvents(sessionId, events, options);
}

function reduceHistoryEventsToMessages(
  sessionId: string,
  events: SessionHistoryEvent[],
  options: { lazyToolOutput?: boolean } = {},
): EnhancedMessage[] {
  return reduceHistoryEventsToReplayState(sessionId, events, options).messages;
}

function getGroupedPageStartIndex(prefixMessages: EnhancedMessage[], limit: number): number {
  const grouped = groupMessages(prefixMessages);
  if (grouped.length <= limit) {
    return 0;
  }

  const firstVisibleGroup = grouped[grouped.length - limit];
  const firstMessage = firstVisibleGroup.kind === 'single'
    ? firstVisibleGroup.message
    : firstVisibleGroup.messages[0];

  const startIndex = prefixMessages.indexOf(firstMessage);
  if (startIndex >= 0) {
    return startIndex;
  }

  // Fallback: should not happen because groupMessages reuses object references.
  return Math.max(0, prefixMessages.length - limit);
}

export function paginateReplayMessages(
  messages: EnhancedMessage[],
  options: { limit?: number; beforeBytes?: number } = {},
): PaginatedReplayMessages {
  const limit = options.limit ?? 100;
  const endIndex = Math.min(options.beforeBytes ?? messages.length, messages.length);
  const prefixMessages = messages.slice(0, endIndex);

  if (prefixMessages.length === 0) {
    return {
      messages: [],
      hasMore: false,
      nextBeforeBytes: 0,
    };
  }

  const startIndex = getGroupedPageStartIndex(prefixMessages, limit);

  return {
    messages: messages.slice(startIndex, endIndex),
    hasMore: startIndex > 0,
    nextBeforeBytes: startIndex,
  };
}

const HISTORY_KEY = Symbol.for('tessera.sessionHistoryStore');
const historyGlobal = globalThis as unknown as Record<symbol, SessionHistoryStore>;

export const sessionHistory =
  historyGlobal[HISTORY_KEY] || (historyGlobal[HISTORY_KEY] = new SessionHistoryStore());

export type {
  PersistedContextUsage,
  PersistedUsage,
  SessionHistoryEvent,
  SessionHistoryPage,
  SessionHistoryReplayState,
};
export { reduceHistoryEventsToMessages, reduceHistoryEventsToReplayState };
