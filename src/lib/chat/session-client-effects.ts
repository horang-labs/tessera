import { useChatStore } from '@/stores/chat-store';
import { applySessionReplayEventsToStores } from './apply-session-replay-events';

const LOCAL_EVENT_VERSION = 1;

export function startTurnInFlight(sessionId: string): void {
  useChatStore.getState().setTurnInFlight(sessionId, true);
}

export function stopTurnInFlight(sessionId: string): void {
  useChatStore.getState().setTurnInFlight(sessionId, false);
}

export function clearInteractivePromptState(sessionId: string, toolUseId?: string): void {
  applySessionReplayEventsToStores(sessionId, [{
    v: LOCAL_EVENT_VERSION,
    type: 'interactive_prompt_cleared',
    timestamp: new Date().toISOString(),
    ...(toolUseId ? { toolUseId } : {}),
  }]);
}

export function applyLocalInteractiveResponseStart(
  sessionId: string,
  toolUseId: string,
  response: string,
): void {
  if (toolUseId) {
    applySessionReplayEventsToStores(sessionId, [{
      v: LOCAL_EVENT_VERSION,
      type: 'interactive_prompt_response',
      timestamp: new Date().toISOString(),
      toolUseId,
      response,
    }]);
  }
  startTurnInFlight(sessionId);
}

export function finalizeInFlightTurn(sessionId: string, options: { clearPrompt?: boolean } = {}): void {
  const chatStore = useChatStore.getState();

  stopTurnInFlight(sessionId);
  chatStore.flushAndClearAssistantText(sessionId);

  if (options.clearPrompt) {
    clearInteractivePromptState(sessionId);
  }

  const messages = chatStore.messages.get(sessionId) || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'thinking' && msg.status === 'streaming' && msg.thinkingId) {
      chatStore.updateThinkingMessage(sessionId, msg.thinkingId, {
        status: 'completed',
      });
      break;
    }
    if (msg.type === 'tool_call' && msg.status === 'running') {
      chatStore.updateToolCall(sessionId, msg.id, { status: 'completed' });
      break;
    }
    if ('role' in msg && msg.role === 'user') {
      break;
    }
  }
}
