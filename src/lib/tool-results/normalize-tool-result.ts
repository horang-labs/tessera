import type {
  AskUserQuestionToolResult,
  AsyncTaskToolResult,
  BashToolResult,
  EditToolResult,
  EnterPlanModeToolResult,
  ExitPlanModeToolResult,
  GlobToolResult,
  GrepToolResult,
  McpToolResult,
  ReadToolResult,
  TaskOutputToolResult,
  TaskStopToolResult,
  TaskToolResult,
  TodoWriteToolResult,
  WebFetchToolResult,
  WebSearchToolResult,
  WriteToolResult,
} from '@/types/cli-jsonl-schemas';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type {
  BackgroundTaskOutputResult,
  BackgroundTaskStopResult,
  CanonicalToolResult,
  CanonicalToolResultValue,
  CommandExecutionToolResult,
  FileChangeToolResult,
  FileReadToolResult,
  InteractiveQuestionToolResult,
  PlanModeToolResult,
  SearchToolResult,
  SubagentTaskToolResult,
  TextBlockToolResult,
  TodoUpdateToolResult,
  WebToolResult,
} from '@/types/tool-result';

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface SyntheticSubagentTaskResult extends Record<string, any> {
  _synthetic: true;
  subagent_type?: string;
  description?: string;
  prompt?: string;
  model?: string;
  run_in_background?: boolean;
}

function isSyntheticSubagentTaskResult(value: unknown): value is SyntheticSubagentTaskResult {
  return isObject(value) && value._synthetic === true;
}

function isAsyncSubagentTaskResult(value: unknown): value is AsyncTaskToolResult {
  return isObject(value)
    && value.isAsync === true
    && value.status === 'async_launched'
    && typeof value.agentId === 'string';
}

function isCompletedSubagentTaskResult(value: unknown): value is TaskToolResult {
  return isObject(value)
    && typeof value.agentId === 'string'
    && typeof value.prompt === 'string'
    && Array.isArray(value.content)
    && (value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled');
}

export function isCanonicalToolResult(value: unknown): value is CanonicalToolResult {
  return isObject(value) && typeof value.kind === 'string';
}

function normalizeCommandExecutionResult(result: BashToolResult): CommandExecutionToolResult {
  return {
    kind: 'command_execution',
    stdout: result.stdout,
    stderr: result.stderr,
    interrupted: result.interrupted,
    ...(result.noOutputExpected !== undefined ? { noOutputExpected: result.noOutputExpected } : {}),
    ...(result.backgroundTaskId ? { backgroundTaskId: result.backgroundTaskId } : {}),
    ...(result.isImage ? { outputMedia: 'image' as const } : {}),
  };
}

function normalizeFileReadResult(result: ReadToolResult): FileReadToolResult {
  if (result.type === 'image') {
    return {
      kind: 'file_read',
      contentType: 'image',
      base64: result.file.base64,
      mimeType: result.file.type,
      originalSize: result.file.originalSize,
      dimensions: result.file.dimensions,
    };
  }

  return {
    kind: 'file_read',
    contentType: 'text',
    path: result.file.filePath,
    content: result.file.content,
    startLine: result.file.startLine,
    lineCount: result.file.numLines,
    totalLines: result.file.totalLines,
  };
}

function normalizeFileChangeResult(result: EditToolResult | WriteToolResult): FileChangeToolResult {
  const isWrite = 'type' in result;
  return {
    kind: 'file_change',
    operation: isWrite ? result.type : 'update',
    path: result.filePath,
    beforeText: isWrite ? result.originalFile : result.oldString,
    afterText: isWrite ? result.content : result.newString,
    diff: result.structuredPatch,
    ...(!isWrite && result.userModified !== undefined ? { userModified: result.userModified } : {}),
    ...(!isWrite && result.replaceAll !== undefined ? { replaceAll: result.replaceAll } : {}),
  };
}

function normalizeSearchResult(result: GrepToolResult | GlobToolResult): SearchToolResult {
  if ('durationMs' in result) {
    return {
      kind: 'search_result',
      source: 'glob',
      mode: 'files',
      files: result.filenames,
      totalFiles: result.numFiles,
      durationMs: result.durationMs,
      truncated: result.truncated,
    };
  }

  return {
    kind: 'search_result',
    source: 'grep',
    mode: result.mode === 'content' ? 'content' : 'files',
    files: result.filenames,
    totalFiles: result.numFiles,
    ...(result.mode === 'content' ? { content: result.content } : {}),
  };
}

function normalizeSubagentTaskResult(result: TaskToolResult | AsyncTaskToolResult | Record<string, any>): SubagentTaskToolResult | undefined {
  if (isSyntheticSubagentTaskResult(result)) {
    return {
      kind: 'subagent_task',
      phase: 'started',
      agentType: typeof result.subagent_type === 'string' ? result.subagent_type : 'general-purpose',
      description: typeof result.description === 'string' ? result.description : '',
      prompt: typeof result.prompt === 'string' ? result.prompt : '',
      ...(typeof result.model === 'string' ? { model: result.model } : {}),
      ...(typeof result.run_in_background === 'boolean' ? { runInBackground: result.run_in_background } : {}),
    };
  }

  if (isAsyncSubagentTaskResult(result)) {
    return {
      kind: 'subagent_task',
      phase: 'async_started',
      agentId: result.agentId,
      description: result.description,
      prompt: result.prompt,
      ...(typeof result.outputFile === 'string' ? { outputFile: result.outputFile } : {}),
    };
  }

  if (!isCompletedSubagentTaskResult(result)) {
    return undefined;
  }

  return {
    kind: 'subagent_task',
    phase: 'completed',
    status: result.status,
    agentId: result.agentId,
    prompt: result.prompt,
    responseText: Array.isArray(result.content)
      ? result.content.map((entry: any) => entry?.text).filter((text: unknown): text is string => typeof text === 'string').join('\n')
      : '',
    metrics: {
      totalDurationMs: typeof result.totalDurationMs === 'number' ? result.totalDurationMs : 0,
      totalTokens: typeof result.totalTokens === 'number' ? result.totalTokens : 0,
      totalToolUseCount: typeof result.totalToolUseCount === 'number' ? result.totalToolUseCount : 0,
      ...(typeof result.usage?.cost === 'number' ? { costUsd: result.usage.cost } : {}),
    },
  };
}

function normalizeBackgroundTaskResult(result: TaskOutputToolResult | TaskStopToolResult): BackgroundTaskOutputResult | BackgroundTaskStopResult | undefined {
  if ('retrieval_status' in result) {
    return {
      kind: 'background_task',
      action: 'output',
      retrievalStatus: result.retrieval_status,
      task: {
        id: result.task.task_id,
        type: result.task.task_type,
        status: result.task.status,
        description: result.task.description,
        output: result.task.output,
        ...('exitCode' in result.task ? { exitCode: result.task.exitCode } : {}),
        ...('prompt' in result.task ? { prompt: result.task.prompt } : {}),
        ...('result' in result.task ? { result: result.task.result } : {}),
      },
    };
  }

  if ('task_id' in result) {
    return {
      kind: 'background_task',
      action: 'stop',
      task: {
        id: result.task_id,
        type: result.task_type,
      },
      message: result.message,
      command: result.command,
    };
  }

  return undefined;
}

function normalizeWebResult(result: WebSearchToolResult | WebFetchToolResult): WebToolResult {
  if ('query' in result) {
    const items = result.results.flatMap((entry) => {
      if (typeof entry === 'string') {
        return [];
      }
      return Array.isArray(entry.content) ? entry.content : [];
    });

    return {
      kind: 'web_result',
      mode: 'search',
      query: result.query,
      results: items.map((item) => ({ title: item.title, url: item.url })),
      durationMs: result.durationSeconds * 1000,
    };
  }

  return {
    kind: 'web_result',
    mode: 'fetch',
    url: result.url,
    statusCode: result.code,
    statusText: result.codeText,
    bytes: result.bytes,
    durationMs: result.durationMs,
    content: result.result,
  };
}

function normalizeInteractiveQuestionResult(result: AskUserQuestionToolResult): InteractiveQuestionToolResult {
  return {
    kind: 'interactive_question',
    questions: result.questions,
    answers: result.answers,
    ...(result.annotations ? { annotations: result.annotations } : {}),
  };
}

function normalizeTodoUpdateResult(result: TodoWriteToolResult): TodoUpdateToolResult {
  return {
    kind: 'todo_update',
    previous: result.oldTodos,
    next: result.newTodos,
  };
}

function normalizePlanModeResult(result: EnterPlanModeToolResult | ExitPlanModeToolResult): PlanModeToolResult {
  if ('message' in result) {
    return {
      kind: 'plan_mode',
      action: 'enter',
      message: result.message,
    };
  }

  return {
    kind: 'plan_mode',
    action: 'exit',
    plan: result.plan,
    isAgent: result.isAgent,
    filePath: result.filePath,
  };
}

function normalizeTextBlocksResult(result: McpToolResult): TextBlockToolResult {
  return {
    kind: 'text_blocks',
    blocks: result,
  };
}

export function normalizeToolResult(
  toolKind: ToolCallKind | undefined,
  result: unknown,
): CanonicalToolResultValue | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }

  if (typeof result === 'string') {
    return result;
  }

  if (Array.isArray(result)) {
    return normalizeTextBlocksResult(result as McpToolResult);
  }

  if (isCanonicalToolResult(result)) {
    return result;
  }

  if (!isObject(result)) {
    return undefined;
  }

  switch (toolKind) {
    case 'shell_command':
      return normalizeCommandExecutionResult(result as BashToolResult);
    case 'file_read':
      return normalizeFileReadResult(result as ReadToolResult);
    case 'file_edit':
    case 'file_write':
      return normalizeFileChangeResult(result as EditToolResult | WriteToolResult);
    case 'search_grep':
    case 'search_glob':
      return normalizeSearchResult(result as GrepToolResult | GlobToolResult);
    case 'subagent_task':
      return normalizeSubagentTaskResult(result);
    case 'task_output':
    case 'task_stop':
      return normalizeBackgroundTaskResult(result as TaskOutputToolResult | TaskStopToolResult);
    case 'web_search':
    case 'web_fetch':
      return normalizeWebResult(result as WebSearchToolResult | WebFetchToolResult);
    case 'question_prompt':
      return normalizeInteractiveQuestionResult(result as AskUserQuestionToolResult);
    case 'todo_update':
      return normalizeTodoUpdateResult(result as TodoWriteToolResult);
    default:
      if ('questions' in result && 'answers' in result) {
        return normalizeInteractiveQuestionResult(result as AskUserQuestionToolResult);
      }
      if ('oldTodos' in result && 'newTodos' in result) {
        return normalizeTodoUpdateResult(result as TodoWriteToolResult);
      }
      if ('retrieval_status' in result || 'task_id' in result) {
        return normalizeBackgroundTaskResult(result as TaskOutputToolResult | TaskStopToolResult);
      }
      if ('query' in result || 'url' in result) {
        return normalizeWebResult(result as WebSearchToolResult | WebFetchToolResult);
      }
      if ('plan' in result || 'message' in result) {
        return normalizePlanModeResult(result as EnterPlanModeToolResult | ExitPlanModeToolResult);
      }
      return undefined;
  }
}
