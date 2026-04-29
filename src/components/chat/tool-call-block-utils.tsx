'use client';

import type { ReactNode } from 'react';
import {
  Bot,
  Code2,
  FileEdit,
  FileText,
  Globe,
  MessageCircleQuestion,
  Search,
  Terminal,
} from 'lucide-react';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import type {
  BackgroundTaskToolResult,
  CommandExecutionToolResult,
  FileChangeToolResult,
  FileReadToolResult,
  SearchToolResult,
  SubagentTaskToolResult,
  TodoUpdateToolResult,
  WebToolResult,
} from '@/types/tool-result';
import { inferToolCallKindFromToolName, type ToolCallKind } from '@/types/tool-call-kind';
import { normalizeToolResult } from '@/lib/tool-results/normalize-tool-result';
import { BashResult } from './tool-results/bash-result';
import { DiffResult } from './tool-results/diff-result';
import { MiscResult } from './tool-results/misc-result';
import { ReadResult } from './tool-results/read-result';
import { SearchResult } from './tool-results/search-result';
import { TaskResult } from './tool-results/task-result';
import { WebResult } from './tool-results/web-result';
import { ErrorBlock } from './shared/error-block';

const TRUNCATE_LINES = 4;
const MAX_RENDER_LENGTH = 2000;

export const TOOL_STATUS_TEXT = {
  completed: 'text-[color:color-mix(in_srgb,var(--success)_42%,var(--text-muted))] opacity-80',
  error: 'text-[color:color-mix(in_srgb,var(--error)_45%,var(--text-muted))] opacity-80',
  running: 'text-(--accent)',
};

export function resolveToolUseId(id: string, explicitToolUseId?: string): string | null {
  if (explicitToolUseId) return explicitToolUseId;
  if (!id) return null;

  const inlineMatch = id.match(/-tool-(.+)$/);
  if (inlineMatch) return inlineMatch[1];

  const historyMatch = id.match(/^hist-tool-(.+)$/);
  return historyMatch ? historyMatch[1] : null;
}

export function shortenToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const lastSeparator = name.lastIndexOf('__');
    if (lastSeparator > 4) {
      return name.slice(lastSeparator + 2);
    }
  }

  return name;
}

export function getToolIcon(toolName: string, toolKind?: ToolCallKind): ReactNode {
  switch (toolKind ?? inferToolCallKindFromToolName(shortenToolName(toolName))) {
    case 'shell_command':
      return <Terminal className="h-3.5 w-3.5" />;
    case 'file_read':
      return <FileText className="h-3.5 w-3.5" />;
    case 'file_write':
    case 'file_edit':
      return <FileEdit className="h-3.5 w-3.5" />;
    case 'search_glob':
    case 'search_grep':
      return <Search className="h-3.5 w-3.5" />;
    case 'web_fetch':
    case 'web_search':
      return <Globe className="h-3.5 w-3.5" />;
    case 'subagent_task':
      return <Bot className="h-3.5 w-3.5" />;
    case 'question_prompt':
      return <MessageCircleQuestion className="h-3.5 w-3.5" />;
    default:
      return <Code2 className="h-3.5 w-3.5" />;
  }
}

export function getToolSummary(
  toolName: string,
  toolParams: Record<string, any>,
  toolKind?: ToolCallKind,
  toolDisplay?: ToolDisplayMetadata,
): string {
  const effectiveKind = toolKind ?? inferToolCallKindFromToolName(toolName);

  if (effectiveKind === 'question_prompt') {
    const questions = toolParams.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      return questions.length === 1
        ? (questions[0].header || 'Question')
        : `${questions.length} questions`;
    }
    return 'Question';
  }

  if (effectiveKind === 'shell_command') {
    const text = toolDisplay?.shellCommand?.displayCommand || toolParams.command || toolParams.description || '';
    return text.length > 60 ? `${text.slice(0, 60)}...` : text;
  }

  if (effectiveKind === 'todo_update' && Array.isArray(toolParams.todos)) {
    const target = toolParams.todos.find((todo: any) => todo.status === 'in_progress')
      || toolParams.todos.find((todo: any) => todo.status === 'pending')
      || toolParams.todos[0];

    if (target?.content || target?.subject) {
      const summary = target.content || target.subject;
      return summary.length > 60 ? `${summary.slice(0, 60)}...` : summary;
    }

    return `${toolParams.todos.length} tasks`;
  }

  if (effectiveKind === 'subagent_task' && toolParams.subagent_type) {
    const agentType = toolParams.subagent_type;
    const description = toolParams.description || '';
    const combined = description ? `[${agentType}] ${description}` : `[${agentType}]`;
    return combined.length > 70 ? `${combined.slice(0, 70)}...` : combined;
  }

  if (toolParams.file_path) return toolParams.file_path;
  if (toolParams.pattern) return toolParams.pattern;

  if (toolParams.description) {
    const description = toolParams.description;
    return description.length > 60 ? `${description.slice(0, 60)}...` : description;
  }

  if (toolParams.query) {
    const query = toolParams.query;
    return query.length > 60 ? `${query.slice(0, 60)}...` : query;
  }

  if (toolName.startsWith('mcp__')) {
    let bestPreview = '';
    for (const value of Object.values(toolParams)) {
      if (typeof value === 'string' && value.length > bestPreview.length) {
        bestPreview = value;
      }
    }

    if (bestPreview) {
      return bestPreview.length > 50 ? `${bestPreview.slice(0, 50)}...` : bestPreview;
    }

    const firstValue = Object.values(toolParams)[0];
    if (firstValue != null) {
      const serialized = JSON.stringify(firstValue);
      return serialized.length > 50 ? `${serialized.slice(0, 50)}...` : serialized;
    }
  }

  return '';
}

export function formatToolParams(
  toolName: string,
  toolParams: Record<string, any>,
  toolKind?: ToolCallKind,
  toolDisplay?: ToolDisplayMetadata,
): string {
  try {
    if ((toolKind ?? inferToolCallKindFromToolName(toolName)) === 'shell_command' && toolDisplay?.shellCommand) {
      const { displayCommand, commandName, argumentsText, cwd, processId } = toolDisplay.shellCommand;
      const parts = [`command: ${JSON.stringify(commandName || displayCommand)}`];
      if (argumentsText) parts.push(`args: ${JSON.stringify(argumentsText)}`);
      if (cwd) parts.push(`cwd: ${JSON.stringify(cwd)}`);
      if (processId) parts.push(`processId: ${JSON.stringify(processId)}`);
      return parts.join('\n');
    }

    const entries = Object.entries(toolParams);
    if (entries.length === 0) return '';

    const parts: string[] = [];
    for (const [key, value] of entries) {
      if (typeof value === 'string' && value.length > 200) {
        parts.push(`${key}: "${value.slice(0, 100)}..."`);
      } else {
        parts.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return parts.join('\n');
  } catch {
    return String(toolParams);
  }
}

export function buildOutputPreview(effectiveOutput?: string) {
  if (!effectiveOutput) {
    return { truncatedOutput: '', totalLines: 0, isLong: false, remainingLines: 0 };
  }

  const lines = effectiveOutput.split('\n');
  const totalLines = lines.length;
  const isLong = totalLines > TRUNCATE_LINES || effectiveOutput.length > MAX_RENDER_LENGTH;

  if (!isLong) {
    return { truncatedOutput: effectiveOutput, totalLines, isLong: false, remainingLines: 0 };
  }

  const preview = lines.slice(0, TRUNCATE_LINES).join('\n');
  const truncatedOutput = preview.length > MAX_RENDER_LENGTH
    ? preview.slice(0, MAX_RENDER_LENGTH)
    : preview;

  return {
    truncatedOutput,
    totalLines,
    isLong: true,
    remainingLines: totalLines - TRUNCATE_LINES,
  };
}

export function getToolBlockTone(isError: boolean, isRunning: boolean) {
  return {
    statusColor: isError
      ? TOOL_STATUS_TEXT.error
      : isRunning
        ? TOOL_STATUS_TEXT.running
        : TOOL_STATUS_TEXT.completed,
    borderColor: isError
      ? 'border-(--status-error-border)'
      : 'border-(--tool-border)',
  };
}

export function renderToolCallResult({
  toolName,
  toolKind,
  toolUseResult,
  toolParams,
  toolDisplay,
}: {
  toolName: string;
  toolKind?: ToolCallKind;
  toolUseResult: unknown;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
}): ReactNode | null {
  let parsedResult = toolUseResult;
  if (typeof toolUseResult === 'string') {
    try {
      parsedResult = JSON.parse(toolUseResult);
    } catch {
      return <ErrorBlock message={toolUseResult} title="Tool Error" />;
    }
  }

  const normalizedResult = normalizeToolResult(
    toolKind ?? inferToolCallKindFromToolName(toolName),
    parsedResult,
  );

  if (!normalizedResult || typeof normalizedResult === 'string') {
    return null;
  }

  switch (normalizedResult.kind) {
    case 'command_execution':
      return <BashResult result={normalizedResult as CommandExecutionToolResult} />;
    case 'file_read':
      return <ReadResult result={normalizedResult as FileReadToolResult} filePath={toolParams.file_path} />;
    case 'file_change': {
      const result = normalizedResult as FileChangeToolResult;
      const diffToolName = result.operation === 'create'
        ? 'Write'
        : toolKind === 'file_edit'
          ? 'Edit'
          : 'Write';
      return <DiffResult result={result} toolName={diffToolName} />;
    }
    case 'search_result': {
      const result = normalizedResult as SearchToolResult;
      return <SearchResult result={result} toolName={result.source === 'glob' ? 'Glob' : 'Grep'} />;
    }
    case 'subagent_task':
      return <TaskResult result={normalizedResult as SubagentTaskToolResult} />;
    case 'web_result': {
      const result = normalizedResult as WebToolResult;
      return <WebResult result={result} toolName={result.mode === 'search' ? 'WebSearch' : 'WebFetch'} />;
    }
    case 'background_task':
      return <MiscResult result={normalizedResult as BackgroundTaskToolResult} toolName={toolName} />;
    case 'todo_update':
      return <MiscResult result={normalizedResult as TodoUpdateToolResult} toolName={toolName} />;
    default:
      return null;
  }
}
