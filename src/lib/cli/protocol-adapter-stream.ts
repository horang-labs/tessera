import type { SessionReplayEvent } from '../session-replay-types';
import type { CliMessage } from './types';

export interface ProtocolStreamState {
  activeThinkingId: string | null;
  thinkingSignature: string;
  /** True if at least one thinking_delta was received for the active block. */
  hasReceivedThinkingDelta: boolean;
  /** True if we already emitted an isRedacted:true event for the active block. */
  thinkingRedactedEmitted: boolean;
  isStreamingText: boolean;
  hasStreamedText: boolean;
  processedToolUseIds: Set<string>;
}

interface BuildProtocolStreamReplayEventsArgs {
  contextWindowSizeCache: Map<string, number>;
  event: CliMessage['event'];
  liveEventVersion: number;
  sessionId: string;
  streamState: Map<string, ProtocolStreamState>;
}

function getOrCreateProtocolStreamState(
  streamState: Map<string, ProtocolStreamState>,
  sessionId: string,
): ProtocolStreamState {
  let state = streamState.get(sessionId);
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
    streamState.set(sessionId, state);
  }

  return state;
}

export function resetProtocolStreamTurn(
  streamState: Map<string, ProtocolStreamState>,
  sessionId: string,
): void {
  const state = streamState.get(sessionId);
  if (state) {
    state.hasStreamedText = false;
  }
}

export function buildProtocolStreamReplayEvents({
  contextWindowSizeCache,
  event,
  liveEventVersion,
  sessionId,
  streamState,
}: BuildProtocolStreamReplayEventsArgs): SessionReplayEvent[] {
  if (!event) return [];

  switch (event.type) {
    case 'message_start': {
      const usage = event.message?.usage;
      if (!usage) return [];

      const contextWindowSize = contextWindowSizeCache.get(sessionId);
      return [{
        v: liveEventVersion,
        type: 'context_usage',
        timestamp: new Date().toISOString(),
        inputTokens: usage.input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        contextWindowSize: contextWindowSize || undefined,
      }];
    }

    case 'content_block_start': {
      const block = event.content_block;
      if (!block) return [];

      const state = getOrCreateProtocolStreamState(streamState, sessionId);

      if (block.type === 'thinking') {
        const thinkingId = `thinking-stream-${sessionId}-${Date.now()}`;
        state.activeThinkingId = thinkingId;
        state.thinkingSignature = '';
        state.hasReceivedThinkingDelta = false;
        state.thinkingRedactedEmitted = false;

        return [{
          v: liveEventVersion,
          type: 'thinking_start',
          timestamp: new Date().toISOString(),
          content: '',
          thinkingId,
        }];
      }

      if (block.type === 'text') {
        state.isStreamingText = true;
        state.hasStreamedText = true;
      }

      return [];
    }

    case 'content_block_delta': {
      const delta = event.delta;
      if (!delta) return [];

      const state = streamState.get(sessionId);
      if (!state) return [];

      if (delta.type === 'text_delta' && delta.text) {
        return [{
          v: liveEventVersion,
          type: 'assistant_message_chunk',
          timestamp: new Date().toISOString(),
          content: delta.text,
        }];
      }

      if (delta.type === 'thinking_delta' && delta.thinking && state.activeThinkingId) {
        state.hasReceivedThinkingDelta = true;
        return [{
          v: liveEventVersion,
          type: 'thinking_delta',
          timestamp: new Date().toISOString(),
          thinkingId: state.activeThinkingId,
          contentDelta: delta.thinking,
          status: 'streaming',
        }];
      }

      if (delta.type === 'signature_delta' && delta.signature) {
        state.thinkingSignature += delta.signature;
        // Opus 4.7+ "omitted thinking": signature arrives without any preceding
        // thinking_delta. Emit an isRedacted:true event so the UI can switch to
        // the redacted variant mid-stream.
        if (
          !state.hasReceivedThinkingDelta &&
          !state.thinkingRedactedEmitted &&
          state.activeThinkingId
        ) {
          state.thinkingRedactedEmitted = true;
          return [{
            v: liveEventVersion,
            type: 'thinking_delta',
            timestamp: new Date().toISOString(),
            thinkingId: state.activeThinkingId,
            contentDelta: '',
            status: 'streaming',
            isRedacted: true,
          }];
        }
      }

      return [];
    }

    case 'content_block_stop': {
      const state = streamState.get(sessionId);
      if (!state) return [];

      const replayEvents: SessionReplayEvent[] = [];

      if (state.activeThinkingId) {
        const isRedacted =
          !state.hasReceivedThinkingDelta && !!state.thinkingSignature;
        replayEvents.push({
          v: liveEventVersion,
          type: 'thinking_delta',
          timestamp: new Date().toISOString(),
          thinkingId: state.activeThinkingId,
          contentDelta: '',
          status: 'completed',
          signature: state.thinkingSignature || undefined,
          ...(isRedacted ? { isRedacted: true } : {}),
        });
        state.activeThinkingId = null;
        state.thinkingSignature = '';
        state.hasReceivedThinkingDelta = false;
        state.thinkingRedactedEmitted = false;
      }

      if (state.isStreamingText) {
        state.isStreamingText = false;
      }

      return replayEvents;
    }

    default:
      return [];
  }
}
