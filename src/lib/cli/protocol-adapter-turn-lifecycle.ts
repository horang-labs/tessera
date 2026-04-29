import { hookHandler } from './hook-handler';
import {
  buildCompletionNotification,
  buildCompletionPreview,
  buildProtocolProgressHookReplayEvent,
  buildProtocolResultTextReplayEvent,
  buildProtocolResultUsage,
  buildTypedProtocolProgressReplayEvent,
  parseProtocolResult,
} from './protocol-adapter-events';
import {
  cacheProtocolContextWindowSize,
  finalizeProtocolResultTurn,
  getProtocolLastAssistantMessage,
} from './protocol-adapter-session-state';
import { resetProtocolStreamTurn, type ProtocolStreamState } from './protocol-adapter-stream';
import logger from '../logger';
import type { SessionReplayEvent } from '../session-replay-types';
import type { AppServerMessage } from '../ws/message-types';
import type { CliMessage } from './types';

interface HandleProtocolProgressMessageOptions {
  liveEventVersion: number;
  msg: CliMessage;
  sendAppMessage: (userId: string, message: AppServerMessage) => void;
  sendReplayEvent: (userId: string, sessionId: string, event: SessionReplayEvent) => void;
  sessionId: string;
  userId: string;
}

interface HandleProtocolResultMessageOptions {
  contextWindowSizeCache: Map<string, number>;
  liveEventVersion: number;
  maybeAutoGenerateTitle: (sessionId: string, userId: string) => void;
  msg: CliMessage;
  sendAppMessage: (userId: string, message: AppServerMessage) => void;
  sendReplayEvent: (userId: string, sessionId: string, event: SessionReplayEvent) => void;
  sessionId: string;
  streamState: Map<string, ProtocolStreamState>;
  userId: string;
}

export function handleProtocolProgressMessage({
  liveEventVersion,
  msg,
  sendAppMessage,
  sendReplayEvent,
  sessionId,
  userId,
}: HandleProtocolProgressMessageOptions): void {
  const raw = msg as any;
  const typedProgressEvent = buildTypedProtocolProgressReplayEvent(
    sessionId,
    msg,
    liveEventVersion,
  );
  if (typedProgressEvent) {
    sendReplayEvent(userId, sessionId, typedProgressEvent);
    return;
  }

  const hookEvent = raw.data?.hookEvent;

  if (!hookEvent) {
    const rawString = JSON.stringify(msg);
    logger.warn({
      sessionId,
      msgKeys: Object.keys(msg).join(','),
      dataKeys: msg.data ? Object.keys(msg.data).join(',') : 'N/A',
      rawPreview: rawString.length > 300 ? `${rawString.slice(0, 300)}...` : rawString,
    }, 'Progress message without hookEvent or data.type');
    return;
  }

  const progressHookEvent = buildProtocolProgressHookReplayEvent(
    sessionId,
    hookEvent,
    raw.data,
    liveEventVersion,
  );
  if (progressHookEvent) {
    sendReplayEvent(userId, sessionId, progressHookEvent);
  }

  if (hookEvent === 'Stop') {
    const lastMessage = getProtocolLastAssistantMessage(sessionId);

    hookHandler.handleStopHook(sessionId, userId, lastMessage);
    sendAppMessage(userId, buildCompletionNotification(sessionId, lastMessage));

    logger.info({
      sessionId,
      preview: buildCompletionPreview(lastMessage),
    }, 'Task completion notification sent');
    return;
  }

  if (hookEvent === 'SessionStart') {
    hookHandler.handleSessionStartHook(sessionId, userId);
  }
}

export function handleProtocolResultMessage({
  contextWindowSizeCache,
  liveEventVersion,
  maybeAutoGenerateTitle,
  msg,
  sendAppMessage,
  sendReplayEvent,
  sessionId,
  streamState,
  userId,
}: HandleProtocolResultMessageOptions): void {
  const result = parseProtocolResult(msg);

  const streamStateForResult = streamState.get(sessionId);
  const resultTextEvent = buildProtocolResultTextReplayEvent(
    result.resultText,
    Boolean(streamStateForResult?.hasStreamedText),
    liveEventVersion,
  );
  if (resultTextEvent) {
    sendReplayEvent(userId, sessionId, resultTextEvent);
  }

  cacheProtocolContextWindowSize(
    contextWindowSizeCache,
    sessionId,
    result.contextWindowSize,
  );

  logger.info({
    sessionId,
    success: !result.isError,
    duration: result.durationMs,
    turns: result.numTurns,
    cost: result.costUsd,
    modelUsageRaw: result.modelUsageRaw,
    primaryModelName: result.primaryModelName,
    contextWindowSize: result.contextWindowSize,
  }, 'Task result received');

  const lastAssistantMessage = finalizeProtocolResultTurn(sessionId);
  resetProtocolStreamTurn(streamState, sessionId);

  sendAppMessage(
    userId,
    buildCompletionNotification(
      sessionId,
      lastAssistantMessage,
      buildProtocolResultUsage(result),
    ),
  );

  if (!result.isError) {
    maybeAutoGenerateTitle(sessionId, userId);
  }
}
