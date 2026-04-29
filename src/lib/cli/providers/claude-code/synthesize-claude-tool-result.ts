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
