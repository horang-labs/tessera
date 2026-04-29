import { processManager } from './process-manager';
import { maybeAutoGenerateProtocolTitle } from './protocol-adapter-auto-title';
import { extractTodoSnapshot } from './providers/claude-code/synthesize-claude-tool-result';
import type { CliCommandInfo, PendingPermissionRequest, PendingToolCall } from './types';
import type { AppServerMessage } from '../ws/message-types';

export type ProtocolTodoSnapshot = Array<{
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}>;

export function queueProtocolPendingPermissionRequest(
  sessionId: string,
  key: string,
  request: PendingPermissionRequest,
): void {
  const processInfo = processManager.getProcess(sessionId);
  if (!processInfo) {
    return;
  }

  if (!processInfo.pendingPermissionRequests) {
    processInfo.pendingPermissionRequests = new Map();
  }

  processInfo.pendingPermissionRequests.set(key, request);
}

export function storeProtocolSessionCommands(
  sessionId: string,
  commands: CliCommandInfo[],
): void {
  processManager.storeCommands(sessionId, commands);
}

export function storeProtocolPendingToolCall(
  sessionId: string,
  toolUseId: string,
  pendingTool: PendingToolCall,
): void {
  const processInfo = processManager.getProcess(sessionId);
  if (!processInfo) {
    return;
  }

  if (!processInfo.pendingToolCalls) {
    processInfo.pendingToolCalls = new Map();
  }

  processInfo.pendingToolCalls.set(toolUseId, pendingTool);
}

export function getProtocolPendingToolCall(
  sessionId: string,
  toolUseId: string,
): PendingToolCall | undefined {
  return processManager.getProcess(sessionId)?.pendingToolCalls?.get(toolUseId);
}

export function getProtocolPendingToolCount(sessionId: string): number {
  return processManager.getProcess(sessionId)?.pendingToolCalls?.size ?? 0;
}

export function storeProtocolLastAssistantMessage(
  sessionId: string,
  content: string,
): void {
  const processInfo = processManager.getProcess(sessionId);
  if (processInfo) {
    processInfo.lastAssistantMessage = content;
  }
}

export function getProtocolLastAssistantMessage(sessionId: string): string | undefined {
  return processManager.getProcess(sessionId)?.lastAssistantMessage;
}

export function finalizeProtocolResultTurn(sessionId: string): string | undefined {
  processManager.updateStatus(sessionId, 'running');
  processManager.setIsGenerating(sessionId, false);
  return getProtocolLastAssistantMessage(sessionId);
}

export function finalizeProtocolPendingToolCall(
  lastTodoSnapshots: Map<string, ProtocolTodoSnapshot>,
  sessionId: string,
  toolUseId: string,
  pendingTool: PendingToolCall,
): void {
  const nextTodos = extractTodoSnapshot(pendingTool.toolKind, pendingTool.toolParams);
  if (nextTodos) {
    lastTodoSnapshots.set(sessionId, nextTodos);
  }

  processManager.getProcess(sessionId)?.pendingToolCalls?.delete(toolUseId);
}

export function cacheProtocolContextWindowSize(
  contextWindowSizeCache: Map<string, number>,
  sessionId: string,
  contextWindowSize?: number,
): void {
  if (contextWindowSize && contextWindowSize > 0) {
    contextWindowSizeCache.set(sessionId, contextWindowSize);
  }
}

export function cleanupProtocolSessionState(
  streamState: Map<string, unknown>,
  contextWindowSizeCache: Map<string, number>,
  lastTodoSnapshots: Map<string, ProtocolTodoSnapshot>,
  sessionId: string,
): void {
  streamState.delete(sessionId);
  contextWindowSizeCache.delete(sessionId);
  lastTodoSnapshots.delete(sessionId);
}

export function maybeTriggerProtocolAutoTitle(
  autoTitleTriggered: Set<string>,
  sendAppMessage: (userId: string, message: AppServerMessage) => void,
  sessionId: string,
  userId: string,
): void {
  maybeAutoGenerateProtocolTitle({
    autoTitleTriggered,
    sendAppMessage,
    sessionId,
    userId,
  });
}
