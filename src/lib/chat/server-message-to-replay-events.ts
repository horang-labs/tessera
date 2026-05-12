import type { ServerMessage } from '@/lib/ws/message-types';
import type { SessionReplayEvent } from '@/lib/session-replay-types';
import { buildToolAgentContextEvents } from '@/lib/agent-context-events';

const LIVE_EVENT_VERSION = 1;

export function serverMessageToReplayEvents(msg: ServerMessage): SessionReplayEvent[] {
  const timestamp = 'timestamp' in msg && typeof msg.timestamp === 'string'
    ? msg.timestamp
    : new Date().toISOString();

  switch (msg.type) {
    case 'message':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'assistant_message_chunk',
        timestamp,
        content: msg.content,
      }];

    case 'user_message':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'user_message',
        timestamp,
        content: msg.content,
      }];

    case 'thinking':
      if (msg.status === 'completed') {
        return [{
          v: LIVE_EVENT_VERSION,
          type: 'thinking',
          timestamp: msg.timestamp,
          content: msg.content,
          signature: msg.signature,
          isRedacted: msg.isRedacted,
          thinkingId: msg.thinkingId,
          startTime: msg.timestamp,
          endTime: msg.timestamp,
          elapsedMs: 0,
        }];
      }

      return [{
        v: LIVE_EVENT_VERSION,
        type: 'thinking_start',
        timestamp: msg.timestamp,
        content: msg.content,
        signature: msg.signature,
        isRedacted: msg.isRedacted,
        thinkingId: msg.thinkingId,
      }];

    case 'thinking_update':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'thinking_delta',
        timestamp: msg.timestamp,
        contentDelta: msg.contentDelta,
        signature: msg.signature,
        isRedacted: msg.isRedacted,
        thinkingId: msg.thinkingId,
        status: msg.status,
      }];

    case 'tool_call':
      {
        const agentContext = msg.agentContext ?? buildToolAgentContextEvents({
          toolName: msg.toolName,
          toolKind: msg.toolKind,
          toolParams: msg.toolParams,
          toolDisplay: msg.toolDisplay,
          status: msg.status,
          output: msg.output,
          error: msg.error,
          toolUseResult: msg.toolUseResult,
        });

        return [{
          v: LIVE_EVENT_VERSION,
          type: 'tool_call',
          timestamp: msg.timestamp,
          toolName: msg.toolName,
          toolKind: msg.toolKind,
          toolParams: msg.toolParams,
          toolDisplay: msg.toolDisplay,
          status: msg.status,
          output: msg.output,
          error: msg.error,
          toolUseResult: msg.toolUseResult,
          ...(agentContext.length > 0 ? { agentContext } : {}),
          toolUseId: msg.toolUseId,
        }];
      }

    case 'system':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'system',
        timestamp: msg.timestamp,
        message: msg.message,
        severity: msg.severity,
        subtype: msg.subtype,
        metadata: msg.metadata,
      }];

    case 'progress_hook':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'progress_hook',
        timestamp: msg.timestamp,
        hookEvent: msg.hookEvent,
        data: msg.data,
        progressType: msg.progressType,
      }];

    case 'interactive_prompt':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'interactive_prompt',
        timestamp,
        promptType: msg.promptType,
        data: msg.data,
      }];

    case 'context_usage':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'context_usage',
        timestamp,
        inputTokens: msg.inputTokens,
        cacheCreationTokens: msg.cacheCreationTokens,
        cacheReadTokens: msg.cacheReadTokens,
        contextWindowSize: msg.contextWindowSize,
      }];

    case 'notification': {
      const events: SessionReplayEvent[] = [];
      if (msg.usage) {
        events.push({
          v: LIVE_EVENT_VERSION,
          type: 'usage',
          timestamp,
          usage: msg.usage,
        });
      }
      if (msg.event === 'completed' || msg.event === 'input_required') {
        events.push({
          v: LIVE_EVENT_VERSION,
          type: 'interactive_prompt_cleared',
          timestamp,
        });
      }
      return events;
    }

    case 'cli_down':
      return [{
        v: LIVE_EVENT_VERSION,
        type: 'interactive_prompt_cleared',
        timestamp,
      }];

    default:
      return [];
  }
}
