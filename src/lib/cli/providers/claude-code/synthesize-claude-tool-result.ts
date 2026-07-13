import type {
  AskUserQuestionItem,
  StructuredPatchHunk,
  TodoItem,
} from '@/types/cli-jsonl-schemas';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type {
  BackgroundTaskOutputResult,
  BackgroundTaskStopResult,
  CanonicalToolResult,
  CommandExecutionToolResult,
  FileChangeToolResult,
  FileReadToolResult,
  InteractiveQuestionToolResult,
  SubagentTaskToolResult,
  TodoUpdateToolResult,
} from '@/types/tool-result';

interface SynthesizeClaudeToolResultOptions {
  output?: string;
  error?: string;
  isError?: boolean;
  previousTodos?: TodoItem[];
}

export interface ClaudeTaskTodo extends TodoItem {
  id: string;
}

export interface ApplyClaudeTaskToolResultOptions {
  isError?: boolean;
  output?: string;
  previousTasks?: ReadonlyMap<string, ClaudeTaskTodo>;
  previousTodos?: TodoItem[];
  rawToolUseResult?: unknown;
  toolName: string;
  toolParams: Record<string, any>;
}

export interface AppliedClaudeTaskToolResult {
  nextTasks: Map<string, ClaudeTaskTodo>;
  todoUpdate: TodoUpdateToolResult;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function lineCount(text: string): number {
  return text.length === 0 ? 1 : text.split('\n').length;
}

function buildReplacementPatch(oldText: string, newText: string): StructuredPatchHunk[] {
  return [{
    oldStart: 1,
    oldLines: lineCount(oldText),
    newStart: 1,
    newLines: lineCount(newText),
    lines: [
      ...oldText.split('\n').map((line) => `-${line}`),
      ...newText.split('\n').map((line) => `+${line}`),
    ],
  }];
}

function normalizeTodos(rawTodos: unknown): TodoItem[] {
  if (!Array.isArray(rawTodos)) return [];
  return rawTodos
    .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === 'object')
    .map((todo) => ({
      content: toStringValue(todo.content ?? todo.subject),
      status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStructuredCandidates(rawToolUseResult: unknown, output: string): unknown[] {
  const candidates: unknown[] = [];
  for (const value of [rawToolUseResult, output]) {
    if (isRecord(value)) {
      candidates.push(value);
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      candidates.push(JSON.parse(value));
    } catch {
      // Claude may also emit a human-readable output alongside structured data.
    }
  }
  return candidates;
}

function unwrapTaskResult(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['tool_use_result', 'toolUseResult', 'result']) {
    if (isRecord(value[key])) return value[key] as Record<string, unknown>;
  }
  return value;
}

function taskIdFrom(value: unknown): string {
  if (!isRecord(value)) return '';
  const id = value.id ?? value.taskId ?? value.task_id;
  return typeof id === 'string' || typeof id === 'number' ? String(id).trim() : '';
}

function normalizeTask(value: unknown): ClaudeTaskTodo | undefined {
  if (!isRecord(value)) return undefined;
  const id = taskIdFrom(value);
  const content = toStringValue(value.subject ?? value.content).trim();
  if (!id || !content) return undefined;

  return {
    id,
    content,
    status: value.status === 'completed' || value.status === 'in_progress'
      ? value.status
      : 'pending',
    ...(typeof value.activeForm === 'string' ? { activeForm: value.activeForm } : {}),
  };
}

function taskTodos(tasks: ReadonlyMap<string, ClaudeTaskTodo>): TodoItem[] {
  return [...tasks.values()].map(({ content, status, activeForm }) => ({
    content,
    status,
    ...(activeForm ? { activeForm } : {}),
  }));
}

function hasFailedTaskResult(result: Record<string, unknown> | undefined): boolean {
  return result?.success === false || result?.isError === true || result?.is_error === true;
}

function isUsableTaskResult(toolName: string, result: Record<string, unknown>): boolean {
  if (toolName === 'taskcreate') return !!(taskIdFrom(result.task) || taskIdFrom(result));
  if (toolName === 'tasklist') return Array.isArray(result.tasks);
  if (toolName === 'taskget') return Object.hasOwn(result, 'task');
  return result.success === true
    || !!taskIdFrom(result.task)
    || !!taskIdFrom(result)
    || Array.isArray(result.updatedFields)
    || isRecord(result.statusChange);
}

function selectTaskResult(
  toolName: string,
  rawToolUseResult: unknown,
  output: string,
): Record<string, unknown> | undefined {
  const candidates = parseStructuredCandidates(rawToolUseResult, output)
    .map(unwrapTaskResult)
    .filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  return candidates.find(hasFailedTaskResult)
    ?? candidates.find((candidate) => isUsableTaskResult(toolName, candidate));
}

export function isClaudeTaskToolResultFailure(rawToolUseResult: unknown, output: string): boolean {
  return parseStructuredCandidates(rawToolUseResult, output)
    .map(unwrapTaskResult)
    .some(hasFailedTaskResult);
}

/**
 * Apply one completed Claude Task* tool call to its session-scoped task map.
 * Returns undefined for errors, malformed results, and unknown update ids so
 * callers can preserve the previous snapshot without emitting a misleading UI.
 */
export function applyClaudeTaskToolResult(
  options: ApplyClaudeTaskToolResultOptions,
): AppliedClaudeTaskToolResult | undefined {
  const normalizedName = options.toolName.toLowerCase();
  if (!['taskcreate', 'taskupdate', 'tasklist', 'taskget'].includes(normalizedName)) {
    return undefined;
  }
  if (options.isError) return undefined;

  const result = selectTaskResult(
    normalizedName,
    options.rawToolUseResult,
    options.output ?? '',
  );
  if (hasFailedTaskResult(result)) return undefined;

  const previousTasks = options.previousTasks ?? new Map<string, ClaudeTaskTodo>();
  const nextTasks = new Map(previousTasks);

  if (normalizedName === 'taskcreate') {
    const task = normalizeTask(result?.task) ?? normalizeTask(result);
    const id = task?.id || taskIdFrom(result);
    const content = task?.content || toStringValue(options.toolParams.subject ?? options.toolParams.content).trim();
    if (!id || !content) return undefined;
    const activeForm = task?.activeForm
      ?? (typeof options.toolParams.activeForm === 'string' ? options.toolParams.activeForm : undefined);
    nextTasks.set(id, {
      id,
      content,
      status: task?.status ?? 'pending',
      ...(activeForm ? { activeForm } : {}),
    });
  } else if (normalizedName === 'taskupdate') {
    const id = taskIdFrom(options.toolParams) || taskIdFrom(result?.task) || taskIdFrom(result);
    if (!id || !nextTasks.has(id)) return undefined;

    const statusChange = isRecord(result?.statusChange) ? result.statusChange : undefined;
    const expectedPreviousStatus = statusChange?.from;
    if (typeof expectedPreviousStatus === 'string'
      && nextTasks.get(id)?.status !== expectedPreviousStatus) return undefined;

    if (options.toolParams.status === 'deleted') {
      nextTasks.delete(id);
    } else {
      const current = nextTasks.get(id)!;
      const returnedTask = normalizeTask(result?.task);
      const status = options.toolParams.status === 'completed' || options.toolParams.status === 'in_progress'
        ? options.toolParams.status
        : options.toolParams.status === 'pending'
          ? 'pending'
          : returnedTask?.status ?? current.status;
      const content = toStringValue(options.toolParams.subject ?? options.toolParams.content).trim()
        || returnedTask?.content
        || current.content;
      const activeForm = typeof options.toolParams.activeForm === 'string'
        ? options.toolParams.activeForm
        : returnedTask?.activeForm ?? current.activeForm;
      nextTasks.set(id, {
        id,
        content,
        status,
        ...(activeForm ? { activeForm } : {}),
      });
    }
  } else if (normalizedName === 'tasklist') {
    if (!result || !Array.isArray(result.tasks)) return undefined;
    const normalizedTasks = result.tasks.map(normalizeTask);
    if (normalizedTasks.some((task) => task === undefined)) return undefined;
    const taskIds = normalizedTasks.map((task) => task!.id);
    if (new Set(taskIds).size !== taskIds.length) return undefined;
    nextTasks.clear();
    for (const task of normalizedTasks) {
      if (task) nextTasks.set(task.id, task);
    }
  } else {
    if (!result || result.task == null) return undefined;
    const task = normalizeTask(result.task);
    if (!task) return undefined;
    nextTasks.set(task.id, task);
  }

  return {
    nextTasks,
    todoUpdate: {
      kind: 'todo_update',
      previous: options.previousTodos ?? taskTodos(previousTasks),
      next: taskTodos(nextTasks),
    },
  };
}

function normalizeAskUserQuestions(rawQuestions: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions
    .filter((question): question is Record<string, unknown> => !!question && typeof question === 'object')
    .map((question) => ({
      question: toStringValue(question.question),
      header: toStringValue(question.header) || 'Question',
      multiSelect: !!question.multiSelect,
      options: Array.isArray(question.options)
        ? question.options
            .filter((option): option is Record<string, unknown> => !!option && typeof option === 'object')
            .map((option) => ({
              label: toStringValue(option.label),
              description: toStringValue(option.description),
              ...(typeof option.markdown === 'string'
                ? { markdown: option.markdown }
                : typeof option.preview === 'string'
                  ? { markdown: option.preview }
                  : {}),
            }))
        : [],
    }));
}

function parseAskUserAnswers(output: string): Record<string, string> {
  const answers: Record<string, string> = {};
  const matches = output.matchAll(/"([^"\n]+)"="([^"\n]*)"/g);
  for (const [, question, answer] of matches) {
    answers[question] = answer;
  }
  return answers;
}

function inferWriteType(output: string): 'create' | 'update' {
  if (/\b(created|new file)\b/i.test(output)) return 'create';
  return 'update';
}

function synthesizeBashResult(output: string, error: string, isError: boolean): CommandExecutionToolResult {
  return {
    kind: 'command_execution',
    stdout: isError ? '' : output,
    stderr: isError ? (error || output) : '',
    interrupted: /\b(interrupted|cancelled)\b/i.test(output) || /\b(interrupted|cancelled)\b/i.test(error),
  };
}

function synthesizeReadResult(toolParams: Record<string, any>, output: string): FileReadToolResult | undefined {
  const filePath = toStringValue(toolParams.file_path);
  if (!filePath || !output) return undefined;
  return {
    kind: 'file_read',
    contentType: 'text',
    path: filePath,
    content: output,
    lineCount: lineCount(output),
    startLine: 1,
    totalLines: lineCount(output),
  };
}

function synthesizeEditResult(toolParams: Record<string, any>): FileChangeToolResult | undefined {
  const filePath = toStringValue(toolParams.file_path);
  const oldString = toStringValue(toolParams.old_string);
  const newString = toStringValue(toolParams.new_string);
  if (!filePath) return undefined;
  return {
    kind: 'file_change',
    operation: 'update',
    path: filePath,
    beforeText: oldString,
    afterText: newString,
    diff: buildReplacementPatch(oldString, newString),
    userModified: false,
    replaceAll: !!toolParams.replace_all,
  };
}

function synthesizeWriteResult(toolParams: Record<string, any>, output: string): FileChangeToolResult | undefined {
  const filePath = toStringValue(toolParams.file_path);
  const content = toStringValue(toolParams.content);
  if (!filePath) return undefined;
  const type = inferWriteType(output);
  return {
    kind: 'file_change',
    operation: type,
    path: filePath,
    beforeText: type === 'create' ? null : '',
    afterText: content,
    diff: type === 'create' ? [] : buildReplacementPatch('', content),
  };
}

function synthesizeTodoWriteResult(
  toolParams: Record<string, any>,
  previousTodos?: TodoItem[],
): TodoUpdateToolResult | undefined {
  const newTodos = normalizeTodos(toolParams.todos);
  if (newTodos.length === 0) return undefined;
  return {
    kind: 'todo_update',
    previous: previousTodos ?? [],
    next: newTodos,
  };
}

function synthesizeTaskResult(toolParams: Record<string, any>): SubagentTaskToolResult | undefined {
  const subagentType = toStringValue(toolParams.subagent_type);
  const prompt = toStringValue(toolParams.prompt);
  const description = toStringValue(toolParams.description);
  if (!subagentType && !prompt && !description) return undefined;
  return {
    kind: 'subagent_task',
    phase: 'started',
    agentType: subagentType || 'general-purpose',
    description,
    prompt,
    ...(typeof toolParams.model === 'string' ? { model: toolParams.model as string } : {}),
    ...(typeof toolParams.run_in_background === 'boolean' ? { runInBackground: toolParams.run_in_background as boolean } : {}),
  };
}

function synthesizeTaskOutputResult(toolParams: Record<string, any>, output: string, isError: boolean): BackgroundTaskOutputResult | undefined {
  const taskId = toStringValue(toolParams.taskId || toolParams.task_id);
  if (!taskId) return undefined;
  return {
    kind: 'background_task',
    action: 'output',
    retrievalStatus: isError ? 'error' : 'success',
    task: {
      id: taskId,
      type: toolParams.subagent_type ? 'local_agent' : 'local_bash',
      status: isError ? 'failed' : 'completed',
      description: toStringValue(toolParams.description) || `Task #${taskId}`,
      output,
      ...(toolParams.subagent_type
        ? {
            prompt: toStringValue(toolParams.prompt),
            result: output,
          }
        : {
            exitCode: isError ? 1 : 0,
          }),
    },
  };
}

function synthesizeTaskStopResult(toolParams: Record<string, any>, output: string): BackgroundTaskStopResult | undefined {
  const taskId = toStringValue(toolParams.taskId || toolParams.task_id);
  if (!taskId) return undefined;
  return {
    kind: 'background_task',
    action: 'stop',
    message: output || 'Task stopped',
    task: {
      id: taskId,
      type: toolParams.subagent_type ? 'local_agent' : 'local_bash',
    },
    command: toStringValue(toolParams.command || toolParams.description),
  };
}

function synthesizeAskUserQuestionResult(toolParams: Record<string, any>, output: string): InteractiveQuestionToolResult | undefined {
  const questions = normalizeAskUserQuestions(toolParams.questions);
  if (questions.length === 0) return undefined;
  const answers = parseAskUserAnswers(output);
  return {
    kind: 'interactive_question',
    questions,
    answers,
  };
}

export function mapClaudeToolNameToToolKind(toolName: string): ToolCallKind | undefined {
  switch (toolName.toLowerCase()) {
    case 'askuserquestion':
      return 'question_prompt';
    case 'bash':
      return 'shell_command';
    case 'read':
      return 'file_read';
    case 'edit':
      return 'file_edit';
    case 'write':
      return 'file_write';
    case 'grep':
      return 'search_grep';
    case 'glob':
      return 'search_glob';
    case 'task':
    case 'agent':
      return 'subagent_task';
    case 'taskoutput':
      return 'task_output';
    case 'taskstop':
      return 'task_stop';
    case 'websearch':
      return 'web_search';
    case 'webfetch':
      return 'web_fetch';
    case 'todowrite':
    case 'taskcreate':
    case 'taskupdate':
    case 'tasklist':
    case 'taskget':
      return 'todo_update';
    default:
      return undefined;
  }
}

export function synthesizeClaudeToolResult(
  toolKind: ToolCallKind | undefined,
  toolParams: Record<string, any>,
  options: SynthesizeClaudeToolResultOptions = {},
): CanonicalToolResult | undefined {
  const output = options.output ?? '';
  const error = options.error ?? '';
  const isError = options.isError ?? false;

  switch (toolKind) {
    case 'shell_command':
      return synthesizeBashResult(output, error, isError);
    case 'file_read':
      return synthesizeReadResult(toolParams, output);
    case 'file_edit':
      return synthesizeEditResult(toolParams);
    case 'file_write':
      return synthesizeWriteResult(toolParams, output);
    case 'todo_update':
      return synthesizeTodoWriteResult(toolParams, options.previousTodos);
    case 'subagent_task':
      return synthesizeTaskResult(toolParams);
    case 'task_output':
      return synthesizeTaskOutputResult(toolParams, output, isError);
    case 'task_stop':
      return synthesizeTaskStopResult(toolParams, output);
    case 'question_prompt':
      return synthesizeAskUserQuestionResult(toolParams, output);
    default:
      return undefined;
  }
}

export function extractTodoSnapshot(
  toolKind: ToolCallKind | undefined,
  toolParams: Record<string, any>,
): TodoItem[] | undefined {
  if (toolKind !== 'todo_update') {
    return undefined;
  }

  const todos = normalizeTodos(toolParams.todos);
  return todos.length > 0 ? todos : undefined;
}
