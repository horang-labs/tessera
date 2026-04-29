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
import * as dbSessions from '../db/sessions';
import { flushRecompute, scheduleRecompute } from '../git/worktree-diff-stats-cache';
import {
  flushGitPanelRecompute,
  scheduleGitPanelRecompute,
} from '../git/git-panel-cache';
import { syncTaskPr } from '../github/task-pr-sync';
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

function sessionWorkDir(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  if (!session?.work_dir) return null;
  // Diff stats only apply to sessions bound to a managed worktree branch.
  // Plain chats share a project directory and would otherwise trigger
  // pointless recomputes whose broadcasts get filtered out downstream.
  if (!session.worktree_branch) return null;
  return session.work_dir;
}

function sessionTaskId(sessionId: string): string | null {
  const session = dbSessions.getSession(sessionId);
  return session?.task_id ?? null;
}

export function applyManagedParsedMessageSideEffect({
  processes,
  sessionId,
  userId,
  sideEffect,
  setIsGenerating,
  autoGenerateTitle,
}: ApplyManagedParsedMessageSideEffectOptions): void {
  switch (sideEffect.type) {
    case 'set_generating':
      setIsGenerating(sessionId, sideEffect.value);
      if (sideEffect.value === false) {
        const workDir = sessionWorkDir(sessionId);
        if (workDir) void flushRecompute(workDir, userId);
        void flushGitPanelRecompute(sessionId, userId);
        const taskId = sessionTaskId(sessionId);
        if (taskId) void syncTaskPr(taskId);
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
            const taskId = sessionTaskId(sessionId);
            if (taskId) void syncTaskPr(taskId);
          }
          if (isGitStateChangingCommand(cmd)) {
            scheduleGitPanelRecompute(sessionId, userId);
          }
        }
      }
      removePendingToolCall(processes, sessionId, sideEffect.toolUseId);
      {
        const workDir = sessionWorkDir(sessionId);
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
    case 'auto_generate_title':
      autoGenerateTitle(sessionId, userId);
      return;
    case 'update_last_assistant_message':
      return;
  }
}
