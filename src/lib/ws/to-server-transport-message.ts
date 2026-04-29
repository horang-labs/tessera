import { serverMessageToReplayEvents } from '@/lib/chat/server-message-to-replay-events';
import type {
  ReplayTransportedServerMessage,
  ServerMessage,
  ServerTransportMessage,
} from './message-types';

function isReplayTransportedServerMessage(message: ServerMessage): message is ReplayTransportedServerMessage {
  switch (message.type) {
    case 'message':
    case 'tool_call':
    case 'thinking':
    case 'thinking_update':
    case 'system':
    case 'progress_hook':
    case 'context_usage':
      return true;
    default:
      return false;
  }
}

export function toServerTransportMessage(message: ServerMessage): ServerTransportMessage {
  if (!isReplayTransportedServerMessage(message)) {
    return message;
  }

  return {
    type: 'replay_events',
    sessionId: message.sessionId,
    events: serverMessageToReplayEvents(message),
  };
}

