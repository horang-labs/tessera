import logger from '../logger';
import type { SessionReplayEvent } from '../session-replay-types';
import { sendProtocolInteractivePrompt } from './protocol-adapter-prompts';
import {
  finalizeProtocolPendingToolCall,
  getProtocolPendingToolCall,
  getProtocolPendingToolCount,
  storeProtocolLastAssistantMessage,
  storeProtocolPendingToolCall,
  type ProtocolTodoSnapshot,
} from './protocol-adapter-session-state';
import { buildProtocolToolCallCompletion, buildProtocolToolCallStart } from './protocol-adapter-tools';
import type { ProtocolStreamState } from './protocol-adapter-stream';
import { extractOutputString, extractToolResultOutput, parseContentBlocks } from './message-parser';
import type { CliMessage } from './types';
import type { AppServerMessage } from '../ws/message-types';

interface ConversationHandlerBase {
  lastTodoSnapshots: Map<string, ProtocolTodoSnapshot>;
  liveEventVersion: number;
  sendReplayEvent: (userId: string, sessionId: string, event: SessionReplayEvent) => void;
  sessionId: string;
  userId: string;
}

interface HandleProtocolAssistantMessageOptions extends ConversationHandlerBase {
  msg: CliMessage;
  sendAppMessage: (userId: string, message: AppServerMessage) => void;
  streamState: Map<string, ProtocolStreamState>;
}

interface HandleProtocolToolResultMessageOptions extends ConversationHandlerBase {
  msg: CliMessage;
}

interface HandleProtocolUserMessageOptions extends ConversationHandlerBase {
  msg: CliMessage;
}

export function handleProtocolAssistantMessage({
  lastTodoSnapshots,
  liveEventVersion,
  msg,
  sendAppMessage,
  sendReplayEvent,
  sessionId,
  streamState,
  userId,
}: HandleProtocolAssistantMessageOptions): void {
  if (!msg.message?.content) {
    const raw = JSON.stringify(msg);
    logger.warn({
      sessionId,
      msgKeys: Object.keys(msg).join(','),
      rawPreview: raw.length > 300 ? `${raw.slice(0, 300)}...` : raw,
    }, 'Assistant message without content');
    return;
  }

  let textContent = '';
  const parsedBlocks = parseContentBlocks(msg.message.content);

  for (const block of parsedBlocks) {
    switch (block.type) {
      case 'text':
        textContent += block.text;
        break;
      case 'thinking':
        break;
      case 'redacted_thinking':
        sendReplayEvent(userId, sessionId, {
          v: liveEventVersion,
          type: 'thinking',
          timestamp: new Date().toISOString(),
          content: '',
          isRedacted: true,
        });
        logger.debug({ sessionId }, 'Redacted thinking block detected');
        break;
      case 'tool_use': {
        const streamStatus = streamState.get(sessionId);
        if (streamStatus && block.id && streamStatus.processedToolUseIds.has(block.id)) {
          break;
        }

        streamStatus?.processedToolUseIds.add(block.id);
        parseProtocolToolUse({
          lastTodoSnapshots,
          liveEventVersion,
          sendReplayEvent,
          sessionId,
          toolUse: block,
          userId,
        });

        sendProtocolInteractivePrompt({
          sendAppMessage,
          sessionId,
          toolUse: block,
          userId,
        });
        break;
      }
    }
  }

  const streamStatus = streamState.get(sessionId);
  if (textContent.trim() && streamStatus && !streamStatus.hasStreamedText) {
    sendReplayEvent(userId, sessionId, {
      v: liveEventVersion,
      type: 'assistant_message_chunk',
      timestamp: new Date().toISOString(),
      content: textContent,
    });
    logger.info({
      sessionId,
      length: textContent.length,
    }, 'Emitted non-streamed assistant text');
  }

  if (textContent.trim()) {
    storeProtocolLastAssistantMessage(sessionId, textContent);
  }
}

export function handleProtocolToolResultMessage({
  lastTodoSnapshots,
  liveEventVersion,
  msg,
  sendReplayEvent,
  sessionId,
  userId,
}: HandleProtocolToolResultMessageOptions): void {
  if (msg.type !== 'tool_result' || !msg.tool_use_id) {
    const raw = JSON.stringify(msg);
    logger.warn({
      sessionId,
      msgType: msg.type,
      msgKeys: Object.keys(msg).join(','),
      rawPreview: raw.length > 300 ? `${raw.slice(0, 300)}...` : raw,
    }, 'tool_result without tool_use_id');
    return;
  }

  const toolUseId = msg.tool_use_id;
  const isError = msg.message?.is_error || false;
  const output = extractOutputString(msg.message?.content);
  const pendingTool = getProtocolPendingToolCall(sessionId, toolUseId);

  if (!pendingTool) {
    if (isError && output.trim() === 'Answer questions?') {
      sendReplayEvent(userId, sessionId, {
        v: liveEventVersion,
        type: 'system',
        timestamp: new Date().toISOString(),
        message: 'AskUserQuestion permission prompt was auto-denied in non-interactive mode.',
        severity: 'warning',
      });
    }

    logger.warn({
      sessionId,
      toolUseId,
      isError,
      outputPreview: output.length > 200 ? `${output.slice(0, 200)}...` : output,
      pendingToolCount: getProtocolPendingToolCount(sessionId),
    }, 'tool_result for unknown tool_use_id');
    return;
  }

  const { replayEvent } = buildProtocolToolCallCompletion({
    isError,
    liveEventVersion,
    output,
    pendingTool,
    previousTodos: lastTodoSnapshots.get(sessionId),
    sessionId,
    toolUseId,
  });

  sendReplayEvent(userId, sessionId, replayEvent);

  logger.info({
    sessionId,
    toolName: pendingTool.toolName,
    isError,
    outputLength: output.length,
  }, 'Tool result received');

  finalizeProtocolPendingToolCall(lastTodoSnapshots, sessionId, toolUseId, pendingTool);
}

export function handleProtocolUserMessage({
  lastTodoSnapshots,
  liveEventVersion,
  msg,
  sendReplayEvent,
  sessionId,
  userId,
}: HandleProtocolUserMessageOptions): void {
  const content = msg.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  const rawToolUseResult = (msg as any).toolUseResult;

  for (const block of content) {
    const toolResult = extractToolResultOutput(block);
    if (!toolResult) {
      continue;
    }

    const pendingTool = getProtocolPendingToolCall(sessionId, toolResult.toolUseId);
    if (!pendingTool) {
      continue;
    }

    const { replayEvent } = buildProtocolToolCallCompletion({
      isError: toolResult.isError,
      liveEventVersion,
      output: toolResult.output,
      pendingTool,
      previousTodos: lastTodoSnapshots.get(sessionId),
      rawToolUseResult,
      sessionId,
      toolUseId: toolResult.toolUseId,
    });

    sendReplayEvent(userId, sessionId, replayEvent);

    logger.debug({
      sessionId,
      toolName: pendingTool.toolName,
      toolUseId: toolResult.toolUseId,
      isError: toolResult.isError,
      hasToolUseResult: !!rawToolUseResult,
      outputLength: toolResult.output.length,
    }, 'Tool result from user message');

    finalizeProtocolPendingToolCall(
      lastTodoSnapshots,
      sessionId,
      toolResult.toolUseId,
      pendingTool,
    );
  }
}

function parseProtocolToolUse({
  lastTodoSnapshots,
  liveEventVersion,
  sendReplayEvent,
  sessionId,
  toolUse,
  userId,
}: {
  lastTodoSnapshots: Map<string, ProtocolTodoSnapshot>;
  liveEventVersion: number;
  sendReplayEvent: (userId: string, sessionId: string, event: SessionReplayEvent) => void;
  sessionId: string;
  toolUse: { id: string; input: Record<string, any>; name: string };
  userId: string;
}): void {
  if (!toolUse.name || !toolUse.id) {
    const raw = JSON.stringify(toolUse);
    logger.warn({
      sessionId,
      hasName: !!toolUse.name,
      hasId: !!toolUse.id,
      toolUseKeys: Object.keys(toolUse).join(','),
      rawPreview: raw.length > 300 ? `${raw.slice(0, 300)}...` : raw,
    }, 'Malformed tool_use (missing name or id)');
    return;
  }

  const { pendingTool, replayEvent, toolUseId } = buildProtocolToolCallStart({
    liveEventVersion,
    previousTodos: lastTodoSnapshots.get(sessionId),
    toolUse,
  });

  sendReplayEvent(userId, sessionId, replayEvent);

  logger.info({
    sessionId,
    toolName: pendingTool.toolName,
    toolUseId,
    paramsKeys: Object.keys(pendingTool.toolParams),
  }, 'Tool call detected');

  storeProtocolPendingToolCall(sessionId, toolUseId, pendingTool);
}
