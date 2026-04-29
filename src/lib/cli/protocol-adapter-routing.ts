import logger from '../logger';
import type { SessionReplayEvent } from '../session-replay-types';
import { buildProtocolSystemReplayEvent } from './protocol-adapter-events';
import type { CliMessage } from './types';

const KNOWN_IGNORED_MESSAGE_TYPES = new Set(['rate_limit_event']);

type ProtocolMessageHandler = (sessionId: string, userId: string, msg: CliMessage) => void;

interface RouteProtocolMessageOptions {
  handlers: Partial<Record<string, ProtocolMessageHandler>>;
  msg: CliMessage;
  sessionId: string;
  userId: string;
}

interface HandleProtocolSystemMessageOptions {
  liveEventVersion: number;
  msg: CliMessage;
  sendReplayEvent: (userId: string, sessionId: string, event: SessionReplayEvent) => void;
  sessionId: string;
  updateProcessStatus: (sessionId: string, status: 'running') => void;
  userId: string;
}

export function routeProtocolMessage({
  handlers,
  msg,
  sessionId,
  userId,
}: RouteProtocolMessageOptions): void {
  logger.debug({ sessionId, type: msg.type, hasToolUseId: !!(msg as any).tool_use_id }, 'CLI message received');

  const handler = handlers[msg.type];
  if (handler) {
    handler(sessionId, userId, msg);
    return;
  }

  if (KNOWN_IGNORED_MESSAGE_TYPES.has(msg.type)) {
    return;
  }

  const raw = JSON.stringify(msg);
  logger.warn({
    sessionId,
    type: msg.type,
    subtype: (msg as any).subtype,
    keys: Object.keys(msg).join(','),
    rawPreview: raw.length > 500 ? `${raw.slice(0, 500)}... (${raw.length} chars)` : raw,
  }, 'Unknown CLI message type');
}

export function handleProtocolSystemMessage({
  liveEventVersion,
  msg,
  sendReplayEvent,
  sessionId,
  updateProcessStatus,
  userId,
}: HandleProtocolSystemMessageOptions): void {
  if (msg.subtype === 'init') {
    logger.info({
      sessionId,
      userId,
      model: msg.message?.model,
      tools: msg.message?.tools?.length,
    }, 'CLI process initialized');

    updateProcessStatus(sessionId, 'running');

    if (typeof msg.message?.model === 'string' && msg.message.model.trim()) {
      sendReplayEvent(userId, sessionId, {
        v: liveEventVersion,
        type: 'system',
        timestamp: new Date().toISOString(),
        message: `Using ${msg.message.model}`,
        severity: 'info',
      });
    }
    return;
  }

  if (msg.subtype === 'hook_started') {
    logger.debug({
      sessionId,
      hookName: msg.message?.hook_name,
    }, 'Hook started');
    return;
  }

  if (msg.subtype === 'hook_response') {
    logger.debug({
      sessionId,
      hookName: msg.message?.hook_name,
      outcome: msg.message?.outcome,
    }, 'Hook response');
    return;
  }

  const systemEvent = buildProtocolSystemReplayEvent(sessionId, msg, liveEventVersion);
  if (systemEvent) {
    sendReplayEvent(userId, sessionId, systemEvent);
  }
}
