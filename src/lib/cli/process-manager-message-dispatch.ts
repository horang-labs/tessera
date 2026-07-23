import type { ServerTransportMessage } from '../ws/message-types';
import { toServerTransportMessage } from '../ws/to-server-transport-message';
import type { ParsedMessage, ParsedMessageSideEffect } from './providers/types';
import {
  removePendingPermissionRequest,
  removePendingToolCall,
  setPendingPermissionRequest,
  setPendingToolCall,
  updateProviderStateWithRetry,
} from './process-manager-side-effects';
import type { ProcessInfo } from './types';
import { scheduleRecompute } from '../git/worktree-diff-stats-cache';
import { scheduleGitPanelRecompute } from '../git/git-panel-cache';
import {
  getManagedSessionWorkDir,
  getSessionTaskId,
  refreshSessionDiffStateInBackground,
} from '../git/session-diff-refresh';
import {
  extractShellCommandFromToolParams,
  isGitStateChangingCommand,
  isPrImpactingCommand,
} from '../github/pr-command-detector';

type ProcessMap = Map<string, ProcessInfo>;

interface DispatchManagedParsedMessagesOptions {
  sessionId: string;
  userId: string;
  messages: ParsedMessage[];
  getSendToUser: () => ((userId: string, message: ServerTransportMessage) => void) | undefined;
  applyParsedMessageSideEffect: (sessionId: string, userId: string, sideEffect: ParsedMessageSideEffect) => void;
}

interface ApplyManagedParsedMessageSideEffectOptions {
  processes: ProcessMap;
  sessionId: string;
  userId: string;
  sideEffect: ParsedMessageSideEffect;
  setIsGenerating: (sessionId: string, generating: boolean) => void;
  autoGenerateTitle: (sessionId: string, userId: string) => void;
  translateAssistantMessage: (sessionId: string, userId: string) => void;
}

export function dispatchManagedParsedMessages({
  sessionId,
  userId,
  messages,
  getSendToUser,
  applyParsedMessageSideEffect,
}: DispatchManagedParsedMessagesOptions): void {
  const sendToUser = getSendToUser();

  for (const parsedMessage of messages) {
    if (parsedMessage.serverMessage && sendToUser) {
      sendToUser(userId, toServerTransportMessage(parsedMessage.serverMessage));
    }

    if (parsedMessage.sideEffect) {
      applyParsedMessageSideEffect(sessionId, userId, parsedMessage.sideEffect);
    }
  }
}

export function applyManagedParsedMessageSideEffect({
  processes,
  sessionId,
  userId,
  sideEffect,
  setIsGenerating,
  autoGenerateTitle,
  translateAssistantMessage,
}: ApplyManagedParsedMessageSideEffectOptions): void {
  switch (sideEffect.type) {
    case 'set_generating':
      setIsGenerating(sessionId, sideEffect.value);
      if (sideEffect.value === false) {
        refreshSessionDiffStateInBackground(
          sessionId,
          userId,
          'generation completed',
        );
      }
      return;
    case 'update_provider_state':
      updateProviderStateWithRetry(sessionId, sideEffect.providerState);
      return;
    case 'store_commands':
      {
        const info = processes.get(sessionId);
        if (info) {
          info.commands = sideEffect.commands;
        }
      }
      return;
    case 'add_pending_tool_call':
      setPendingToolCall(processes, sessionId, sideEffect.toolUseId, {
        toolName: sideEffect.toolName,
        toolKind: sideEffect.toolKind,
        toolParams: sideEffect.toolParams,
        toolDisplay: sideEffect.toolDisplay,
      });
      return;
    case 'remove_pending_tool_call':
      {
        // Peek at the tool call BEFORE removal so we can inspect its params
        // for PR/git patterns and trigger immediate sync/recompute.
        const pending = processes.get(sessionId)?.pendingToolCalls?.get(sideEffect.toolUseId);
        if (pending) {
          const cmd = extractShellCommandFromToolParams(
            pending.toolName,
            pending.toolParams,
          );
          if (isPrImpactingCommand(cmd)) {
            const taskId = getSessionTaskId(sessionId);
            if (taskId) {
              refreshSessionDiffStateInBackground(
                sessionId,
                userId,
                'pr-impacting command completed',
              );
            }
          }
          if (isGitStateChangingCommand(cmd)) {
            scheduleGitPanelRecompute(sessionId, userId);
          }
        }
      }
      removePendingToolCall(processes, sessionId, sideEffect.toolUseId);
      {
        const workDir = getManagedSessionWorkDir(sessionId);
        if (workDir) scheduleRecompute(workDir, userId);
      }
      return;
    case 'add_pending_permission_request':
      setPendingPermissionRequest(processes, sessionId, sideEffect.toolUseId, {
        requestId: sideEffect.requestId,
        toolName: sideEffect.toolName,
        input: sideEffect.input,
      });
      return;
    case 'remove_pending_permission_request':
      removePendingPermissionRequest(processes, sessionId, sideEffect.toolUseId);
      return;
    case 'send_json_rpc_response':
      {
        const info = processes.get(sessionId);
        info?.provider.sendJsonRpcResponse?.(
          info.process,
          sideEffect.requestId,
          sideEffect.result,
        );
      }
      return;
    case 'send_json_rpc_error':
      {
        const info = processes.get(sessionId);
        info?.provider.sendJsonRpcError?.(
          info.process,
          sideEffect.requestId,
          {
            code: sideEffect.code,
            message: sideEffect.message,
            ...(sideEffect.data !== undefined ? { data: sideEffect.data } : {}),
          },
        );
      }
      return;
    case 'auto_generate_title':
      // Fired on every successful turn completion (all providers). Optional AI
      // refinement self-gates to once per session; output translation gates on
      // its own settings and per-message deduplication.
      autoGenerateTitle(sessionId, userId);
      translateAssistantMessage(sessionId, userId);
      return;
    case 'update_last_assistant_message':
      return;
  }
}
