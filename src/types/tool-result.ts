import type { AskUserQuestionItem, TodoItem, StructuredPatchHunk } from './cli-jsonl-schemas';

export interface CommandExecutionToolResult {
  kind: 'command_execution';
  stdout: string;
  stderr: string;
  interrupted: boolean;
  noOutputExpected?: boolean;
  backgroundTaskId?: string;
  outputMedia?: 'text' | 'image';
}

export interface FileReadTextToolResult {
  kind: 'file_read';
  contentType: 'text';
  path: string;
  content: string;
  startLine: number;
  lineCount: number;
  totalLines: number;
}

export interface FileReadImageToolResult {
  kind: 'file_read';
  contentType: 'image';
  path?: string;
  base64: string;
  mimeType: string;
  originalSize: number;
  dimensions: {
    originalWidth: number;
    originalHeight: number;
    displayWidth: number;
    displayHeight: number;
  };
}

export type FileReadToolResult = FileReadTextToolResult | FileReadImageToolResult;

export interface FileChangeToolResult {
  kind: 'file_change';
  operation: 'create' | 'update';
  path: string;
  beforeText: string | null;
  afterText: string;
  diff: StructuredPatchHunk[];
  userModified?: boolean;
  replaceAll?: boolean;
}

export interface SearchToolResult {
  kind: 'search_result';
  source: 'grep' | 'glob';
  mode: 'content' | 'files';
  files: string[];
  totalFiles: number;
  content?: string;
  durationMs?: number;
  truncated?: boolean;
}

export interface SubagentTaskStartedResult {
  kind: 'subagent_task';
  phase: 'started';
  agentType: string;
  description: string;
  prompt: string;
  model?: string;
  runInBackground?: boolean;
}

export interface SubagentTaskAsyncResult {
  kind: 'subagent_task';
  phase: 'async_started';
  agentId: string;
  description: string;
  prompt: string;
  outputFile?: string;
}

export interface SubagentTaskCompletedResult {
  kind: 'subagent_task';
  phase: 'completed';
  status: 'completed' | 'failed' | 'cancelled';
  agentId: string;
  prompt: string;
  responseText: string;
  metrics: {
    totalDurationMs: number;
    totalTokens: number;
    totalToolUseCount: number;
    costUsd?: number;
  };
}

export type SubagentTaskToolResult =
  | SubagentTaskStartedResult
  | SubagentTaskAsyncResult
  | SubagentTaskCompletedResult;

export interface BackgroundTaskOutputResult {
  kind: 'background_task';
  action: 'output';
  retrievalStatus: 'success' | 'error' | 'not_found';
  task: {
    id: string;
    type: 'local_bash' | 'local_agent';
    status: 'completed' | 'running' | 'failed';
    description: string;
    output: string;
    exitCode?: number;
    prompt?: string;
    result?: string;
  };
}

export interface BackgroundTaskStopResult {
  kind: 'background_task';
  action: 'stop';
  task: {
    id: string;
    type: 'local_bash' | 'local_agent';
  };
  message: string;
  command: string;
}

export type BackgroundTaskToolResult = BackgroundTaskOutputResult | BackgroundTaskStopResult;

export interface WebSearchItem {
  title: string;
  url: string;
}

export interface WebSearchToolResultCanonical {
  kind: 'web_result';
  mode: 'search';
  query: string;
  results: WebSearchItem[];
  durationMs: number;
}

export interface WebFetchToolResultCanonical {
  kind: 'web_result';
  mode: 'fetch';
  url: string;
  statusCode: number;
  statusText: string;
  bytes: number;
  durationMs: number;
  content: string;
}

export type WebToolResult =
  | WebSearchToolResultCanonical
  | WebFetchToolResultCanonical;

export interface InteractiveQuestionToolResult {
  kind: 'interactive_question';
  questions: AskUserQuestionItem[];
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string }>;
}

export interface TodoUpdateToolResult {
  kind: 'todo_update';
  previous: TodoItem[];
  next: TodoItem[];
}

export interface PlanModeToolResult {
  kind: 'plan_mode';
  action: 'enter' | 'exit';
  message?: string;
  plan?: string;
  isAgent?: boolean;
  filePath?: string;
}

export interface TextBlockToolResult {
  kind: 'text_blocks';
  blocks: Array<{ type: 'text'; text: string }>;
}

export type CanonicalToolResult =
  | CommandExecutionToolResult
  | FileReadToolResult
  | FileChangeToolResult
  | SearchToolResult
  | SubagentTaskToolResult
  | BackgroundTaskToolResult
  | WebToolResult
  | InteractiveQuestionToolResult
  | TodoUpdateToolResult
  | PlanModeToolResult
  | TextBlockToolResult;

export type CanonicalToolResultValue = CanonicalToolResult | string;
