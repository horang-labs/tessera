import { buildToolDisplay } from '../tool-display';
import type { SessionReplayEvent } from '../session-replay-types';
import { normalizeToolResult } from '../tool-results/normalize-tool-result';
import {
  extractTodoSnapshot,
  mapClaudeToolNameToToolKind,
  synthesizeClaudeToolResult,
} from './providers/claude-code/synthesize-claude-tool-result';
import { truncateToolResult } from './truncate-tool-result';
import type { PendingToolCall } from './types';

type TodoSnapshotEntry = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

interface BuildProtocolToolCallStartArgs {
  liveEventVersion: number;
  previousTodos?: TodoSnapshotEntry[];
  toolUse: {
    id: string;
    name: string;
    input?: Record<string, any>;
  };
}

interface BuildProtocolToolCallCompletionArgs {
  isError: boolean;
  liveEventVersion: number;
  output: string;
  pendingTool: PendingToolCall;
  previousTodos?: TodoSnapshotEntry[];
  rawToolUseResult?: unknown;
  sessionId: string;
  toolUseId: string;
}

export function buildProtocolToolCallStart({
  liveEventVersion,
  previousTodos,
  toolUse,
}: BuildProtocolToolCallStartArgs): {
  pendingTool: PendingToolCall;
  replayEvent: SessionReplayEvent;
  toolUseId: string;
} {
  const toolName = toolUse.name;
  const toolKind = mapClaudeToolNameToToolKind(toolName);
  const toolParams = toolUse.input || {};
  const toolDisplay = buildToolDisplay(toolName, toolKind, toolParams);
  const toolUseId = toolUse.id;
  const syntheticToolUseResult = synthesizeClaudeToolResult(toolKind, toolParams, {
    previousTodos,
  });

  return {
    toolUseId,
    pendingTool: {
      toolName,
      toolKind,
      toolParams,
      toolDisplay,
    },
    replayEvent: {
      v: liveEventVersion,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      toolName,
      ...(toolKind !== undefined ? { toolKind } : {}),
      toolParams,
      ...(toolDisplay !== undefined ? { toolDisplay } : {}),
      status: 'running',
      ...(syntheticToolUseResult !== undefined ? { toolUseResult: syntheticToolUseResult } : {}),
      toolUseId,
    },
  };
}

export function buildProtocolToolCallCompletion({
  isError,
  liveEventVersion,
  output,
  pendingTool,
  previousTodos,
  rawToolUseResult,
  sessionId,
  toolUseId,
}: BuildProtocolToolCallCompletionArgs): {
  nextTodos?: TodoSnapshotEntry[];
  replayEvent: SessionReplayEvent;
} {
  const toolUseResult = rawToolUseResult
    ? normalizeToolResult(
        pendingTool.toolKind,
        truncateToolResult(rawToolUseResult, {
          sessionId,
          toolName: pendingTool.toolName,
        }),
      )
    : synthesizeClaudeToolResult(pendingTool.toolKind, pendingTool.toolParams, {
        output,
        error: isError ? output : undefined,
        isError,
        previousTodos,
      });

  return {
    nextTodos: extractTodoSnapshot(pendingTool.toolKind, pendingTool.toolParams),
    replayEvent: {
      v: liveEventVersion,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      toolName: pendingTool.toolName,
      ...(pendingTool.toolKind !== undefined ? { toolKind: pendingTool.toolKind } : {}),
      toolParams: pendingTool.toolParams,
      ...(pendingTool.toolDisplay !== undefined ? { toolDisplay: pendingTool.toolDisplay } : {}),
      status: isError ? 'error' : 'completed',
      output: isError ? undefined : output,
      error: isError ? output : undefined,
      ...(toolUseResult !== undefined ? { toolUseResult } : {}),
      toolUseId,
    },
  };
}
