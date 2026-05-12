import type { EnhancedMessage, ToolCallMessage } from '@/types/chat';
import type { SessionReplayEvent } from '@/lib/session-replay-types';
import { inferToolCallKindFromToolName, type ToolCallKind } from '@/types/tool-call-kind';

export interface AgentReferencedFile {
  path: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sources: Array<'read' | 'search' | 'inspect'>;
}

export interface AgentCommandItem {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'error';
  timestamp: string;
  cwd?: string;
  error?: string;
  isVerification: boolean;
}

export interface AgentIssueItem {
  id: string;
  label: string;
  detail?: string;
  tone: 'error' | 'warning';
  timestamp: string;
}

export interface AgentPromptHistoryItem {
  id: string;
  label: string;
  detail?: string;
  timestamp: string;
  status: 'active' | 'resolved';
}

export interface AgentTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress';
  timestamp: string;
}

export type AgentTimelineKind =
  | 'cmd'
  | 'read'
  | 'search'
  | 'edit'
  | 'issue'
  | 'task'
  | 'todo'
  | 'web';

export type AgentTimelineStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'pending'
  | 'in_progress'
  | 'resolved'
  | 'active'
  | 'warning';

export interface AgentTimelineItem {
  id: string;
  kind: AgentTimelineKind;
  timestamp: string;
  title: string;
  detail?: string;
  meta?: string;
  status?: AgentTimelineStatus;
  path?: string;
  command?: string;
  sessionId?: string;
  toolUseId?: string;
  hasOutput?: boolean;
  errorDetail?: string;
}

export interface AgentContextSummary {
  referencedFiles: AgentReferencedFile[];
  commands: AgentCommandItem[];
  verificationCommands: AgentCommandItem[];
  issuesAndPrompts: AgentIssueItem[];
  todos: AgentTodoItem[];
  timeline: AgentTimelineItem[];
}

const READ_LIKE_COMMANDS = new Set([
  'cat',
  'file',
  'gc',
  'get-content',
  'head',
  'less',
  'more',
  'nl',
  'sed',
  'stat',
  'tail',
  'wc',
]);

const WRITE_LIKE_SHELL_PATTERNS = [
  /\bsed\b[\s\S]*?\s-i(?:\s|$|[A-Za-z0-9._=-])/,
  /(^|[^>])>>?($|[^>])/,
  /(^|[\s|;&])tee(\s|$)/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return record ? nonEmptyString(record[key]) : undefined;
}

function firstRecordString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = recordString(record, key);
    if (value) return value;
  }
  return undefined;
}

function toolResultRecord(message: ToolCallMessage): Record<string, unknown> | undefined {
  return isRecord(message.toolUseResult) ? message.toolUseResult : undefined;
}

function extractToolResultErrorDetail(result: unknown): string | undefined {
  if (typeof result === 'string') return nonEmptyString(result);
  if (!isRecord(result)) return undefined;

  const direct = firstRecordString(result, [
    'stderr',
    'error',
    'message',
    'output',
    'stdout',
    'content',
    'responseText',
  ]);
  if (direct) return direct;

  const task = isRecord(result.task) ? result.task : undefined;
  return firstRecordString(task, ['output', 'result', 'message']);
}

function getEffectiveToolKind(message: ToolCallMessage): ToolCallKind | undefined {
  return message.toolKind ?? inferToolCallKindFromToolName(message.toolName);
}

function getDisplayCommand(message: ToolCallMessage): string {
  return message.toolDisplay?.shellCommand?.displayCommand
    || nonEmptyString(message.toolParams.command)
    || nonEmptyString(message.toolParams.description)
    || message.toolName;
}

function getCommandCwd(message: ToolCallMessage): string | undefined {
  return message.toolDisplay?.shellCommand?.cwd || nonEmptyString(message.toolParams.cwd);
}

function unwrapShellLauncher(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|c|fi)?sh\s+-lc\s+([\s\S]+)$/);
  const inner = match?.[1]?.trim();
  if (!inner) return trimmed;

  const quote = inner[0];
  if ((quote === '"' || quote === "'") && inner.endsWith(quote)) {
    return inner.slice(1, -1).trim();
  }
  return inner;
}

function getShellCommandName(command: string): string | undefined {
  const unwrapped = unwrapShellLauncher(command);
  const match = unwrapped.match(/^\s*(?:sudo\s+)?(?:command\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=.*)\s+)*(?:\S+\/)?([A-Za-z0-9._-]+)/);
  return match?.[1]?.toLowerCase();
}

function isWriteLikeShellCommand(command: string): boolean {
  return WRITE_LIKE_SHELL_PATTERNS.some((pattern) => pattern.test(command));
}

function isReadLikeShellCommand(command: string): boolean {
  const commandName = getShellCommandName(command);
  return !!commandName && READ_LIKE_COMMANDS.has(commandName) && !isWriteLikeShellCommand(command);
}

function statusForMessage(message: ToolCallMessage): AgentTimelineStatus {
  return message.status;
}

function joinMeta(parts: Array<string | undefined>): string | undefined {
  const compact = parts.filter((part): part is string => Boolean(part));
  return compact.length > 0 ? compact.join(' | ') : undefined;
}

function formatDurationMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function buildIssueTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const toolKind = getEffectiveToolKind(message);
  const command = toolKind === 'shell_command' ? getDisplayCommand(message) : undefined;
  const errorDetail = nonEmptyString(message.error)
    || extractToolResultErrorDetail(message.toolUseResult)
    || nonEmptyString(message.output);
  const title =
    command
    || (toolKind === 'file_read'
      ? firstRecordString(message.toolParams, ['file_path', 'filePath', 'path', 'notebook_path'])
      : undefined)
    || (toolKind === 'search_grep' || toolKind === 'search_glob'
      ? firstRecordString(message.toolParams, ['pattern', 'query', 'regex'])
      : undefined)
    || (toolKind === 'subagent_task' || toolKind === 'task_output' || toolKind === 'task_stop'
      ? firstRecordString(message.toolParams, ['description', 'prompt'])
      : undefined)
    || message.toolName;
  const detail = errorDetail
    ? truncate(errorDetail, 180)
    : 'No error output captured';

  return {
    id: message.id,
    kind: 'issue',
    timestamp: message.timestamp,
    title,
    detail: truncate(detail, 180),
    status: 'error',
    ...(command ? { command } : {}),
    sessionId: message.sessionId,
    ...(message.toolUseId ? { toolUseId: message.toolUseId } : {}),
    ...(message.hasOutput ? { hasOutput: message.hasOutput } : {}),
    ...(errorDetail ? { errorDetail } : {}),
  };
}

function buildShellTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const command = getDisplayCommand(message);
  const cwd = getCommandCwd(message);
  return {
    id: message.id,
    kind: isReadLikeShellCommand(command) ? 'read' : 'cmd',
    timestamp: message.timestamp,
    title: command,
    command,
    status: statusForMessage(message),
    ...(cwd ? { meta: cwd } : {}),
  };
}

function buildReadTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const result = toolResultRecord(message);
  const path = recordString(result, 'path')
    || firstRecordString(message.toolParams, ['file_path', 'filePath', 'path', 'notebook_path'])
    || message.toolName;
  const startLine = typeof result?.startLine === 'number' ? result.startLine : undefined;
  const lineCount = typeof result?.lineCount === 'number' ? result.lineCount : undefined;
  const meta = typeof startLine === 'number' && typeof lineCount === 'number'
    ? `${startLine}-${startLine + Math.max(0, lineCount - 1)}`
    : undefined;

  return {
    id: message.id,
    kind: 'read',
    timestamp: message.timestamp,
    title: path,
    path,
    status: statusForMessage(message),
    ...(meta ? { meta } : {}),
  };
}

function buildSearchTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const result = toolResultRecord(message);
  const pattern = firstRecordString(message.toolParams, ['pattern', 'query', 'regex']);
  const path = firstRecordString(message.toolParams, ['path', 'cwd', 'include']);
  const title = pattern
    ? path ? `${pattern} · ${path}` : pattern
    : path || message.toolName;
  const totalFiles = typeof result?.totalFiles === 'number' ? result.totalFiles : undefined;
  const duration = formatDurationMs(result?.durationMs);
  const meta = joinMeta([
    typeof totalFiles === 'number' ? `${totalFiles} files` : undefined,
    duration,
  ]);

  return {
    id: message.id,
    kind: 'search',
    timestamp: message.timestamp,
    title,
    status: statusForMessage(message),
    ...(meta ? { meta } : {}),
  };
}

function buildEditTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const result = toolResultRecord(message);
  const path = recordString(result, 'path')
    || firstRecordString(message.toolParams, ['file_path', 'filePath', 'path'])
    || message.toolName;
  const operation = recordString(result, 'operation');

  return {
    id: message.id,
    kind: 'edit',
    timestamp: message.timestamp,
    title: path,
    path,
    status: statusForMessage(message),
    ...(operation ? { meta: operation } : {}),
  };
}

function todoContent(todo: unknown): string | undefined {
  if (!isRecord(todo)) return undefined;
  return firstRecordString(todo, ['content', 'text', 'title']);
}

function todoStatus(todo: unknown): AgentTodoItem['status'] | undefined {
  if (!isRecord(todo)) return undefined;
  return todo.status === 'pending' || todo.status === 'in_progress' ? todo.status : undefined;
}

function collectTodos(message: ToolCallMessage): AgentTodoItem[] {
  const result = toolResultRecord(message);
  const rawTodos = Array.isArray(result?.next)
    ? result.next
    : Array.isArray(message.toolParams.todos)
      ? message.toolParams.todos
      : [];

  return rawTodos.flatMap((todo, index) => {
    const status = todoStatus(todo);
    const content = todoContent(todo);
    if (!status || !content) return [];
    return [{
      id: `${message.id}-todo-${index}`,
      content,
      status,
      timestamp: message.timestamp,
    }];
  });
}

function buildTodoTimelineItem(message: ToolCallMessage, activeTodos: AgentTodoItem[]): AgentTimelineItem {
  const result = toolResultRecord(message);
  const total = Array.isArray(result?.next)
    ? result.next.length
    : Array.isArray(message.toolParams.todos)
      ? message.toolParams.todos.length
      : undefined;
  const title = activeTodos[0]?.content
    || (typeof total === 'number' ? `${total} todos updated` : message.toolName);
  const detail = activeTodos.length > 1
    ? activeTodos.slice(1, 4).map((todo) => todo.content).join(' · ')
    : undefined;
  const hasInProgress = activeTodos.some((todo) => todo.status === 'in_progress');

  return {
    id: message.id,
    kind: 'todo',
    timestamp: message.timestamp,
    title,
    status: hasInProgress ? 'in_progress' : statusForMessage(message),
    ...(detail ? { detail: truncate(detail, 180) } : {}),
    ...(typeof total === 'number' ? { meta: `${activeTodos.length}/${total} active` } : {}),
  };
}

function buildTaskTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const result = toolResultRecord(message);
  const task = isRecord(result?.task) ? result.task : undefined;
  const title = recordString(result, 'description')
    || recordString(task, 'description')
    || firstRecordString(message.toolParams, ['description', 'prompt'])
    || message.toolName;
  const prompt = recordString(result, 'prompt') || recordString(task, 'prompt') || recordString(message.toolParams, 'prompt');
  const responseText = recordString(result, 'responseText') || recordString(task, 'result') || recordString(task, 'output');
  const phase = recordString(result, 'phase') || recordString(result, 'action');
  const resultStatus = recordString(result, 'status') || recordString(task, 'status');
  const agentType = recordString(result, 'agentType') || recordString(task, 'type');
  const agentId = recordString(result, 'agentId') || recordString(task, 'id');
  const status: AgentTimelineStatus =
    resultStatus === 'failed' ? 'error'
      : resultStatus === 'running' || phase === 'started' || phase === 'async_started' ? 'running'
        : statusForMessage(message);

  return {
    id: message.id,
    kind: 'task',
    timestamp: message.timestamp,
    title,
    status,
    ...(prompt && prompt !== title ? { detail: truncate(prompt, 180) } : responseText ? { detail: truncate(responseText, 180) } : {}),
    ...(joinMeta([phase, resultStatus, agentType, agentId]) ? { meta: joinMeta([phase, resultStatus, agentType, agentId]) } : {}),
  };
}

function buildWebTimelineItem(message: ToolCallMessage): AgentTimelineItem {
  const result = toolResultRecord(message);
  const title = recordString(result, 'query')
    || recordString(result, 'url')
    || firstRecordString(message.toolParams, ['query', 'url'])
    || message.toolName;
  const statusCode = typeof result?.statusCode === 'number' ? String(result.statusCode) : undefined;
  const duration = formatDurationMs(result?.durationMs);

  return {
    id: message.id,
    kind: 'web',
    timestamp: message.timestamp,
    title,
    status: statusForMessage(message),
    ...(joinMeta([statusCode, duration]) ? { meta: joinMeta([statusCode, duration]) } : {}),
  };
}

function buildToolTimelineItem(message: ToolCallMessage): {
  item?: AgentTimelineItem;
  todos?: AgentTodoItem[];
} {
  if (message.status === 'error') {
    return { item: buildIssueTimelineItem(message) };
  }

  const toolKind = getEffectiveToolKind(message);
  switch (toolKind) {
    case 'shell_command':
      return { item: buildShellTimelineItem(message) };
    case 'file_read':
      return { item: buildReadTimelineItem(message) };
    case 'search_grep':
    case 'search_glob':
      return { item: buildSearchTimelineItem(message) };
    case 'file_edit':
    case 'file_write':
      return { item: buildEditTimelineItem(message) };
    case 'todo_update': {
      const todos = collectTodos(message);
      return { item: buildTodoTimelineItem(message, todos), todos };
    }
    case 'subagent_task':
    case 'task_output':
    case 'task_stop':
      return { item: buildTaskTimelineItem(message) };
    case 'question_prompt':
      return {};
    case 'web_search':
    case 'web_fetch':
      return { item: buildWebTimelineItem(message) };
    default:
      return {
        item: {
          id: message.id,
          kind: 'cmd',
          timestamp: message.timestamp,
          title: message.toolName,
          status: statusForMessage(message),
        },
      };
  }
}

function buildSystemIssueTimelineItem(message: Extract<EnhancedMessage, { type: 'system' }>): AgentTimelineItem | null {
  if (message.severity !== 'warning' && message.severity !== 'error') return null;
  return {
    id: message.id,
    kind: 'issue',
    timestamp: message.timestamp,
    title: message.severity,
    detail: truncate(message.message, 180),
    status: message.severity,
  };
}

function buildIssueItemFromTimeline(item: AgentTimelineItem): AgentIssueItem {
  return {
    id: item.id,
    label: item.title,
    detail: item.detail,
    tone: item.status === 'warning' ? 'warning' : 'error',
    timestamp: item.timestamp,
  };
}

function buildCommandItemFromTimeline(item: AgentTimelineItem): AgentCommandItem | null {
  if (item.kind !== 'cmd' && !(item.kind === 'read' && item.command)) return null;
  return {
    id: item.id,
    command: item.command || item.title,
    status: item.status === 'error' ? 'error' : item.status === 'running' ? 'running' : 'completed',
    timestamp: item.timestamp,
    cwd: item.meta,
    error: item.status === 'error' ? item.detail : undefined,
    isVerification: false,
  };
}

export function buildAgentPromptHistoryItem(
  event: Extract<SessionReplayEvent, { type: 'interactive_prompt' }>,
): AgentPromptHistoryItem {
  const toolUseId = typeof event.data.toolUseId === 'string' && event.data.toolUseId
    ? event.data.toolUseId
    : event.timestamp;
  const label = event.promptType.replace(/_/g, ' ');
  const detail = typeof event.data.question === 'string'
    ? event.data.question
    : Array.isArray(event.data.questions) && typeof event.data.questions[0]?.question === 'string'
      ? event.data.questions[0].question
      : typeof event.data.toolName === 'string'
        ? event.data.toolName
        : typeof event.data.plan === 'string'
          ? event.data.plan
          : undefined;

  return {
    id: `prompt-${toolUseId}`,
    label,
    detail: detail ? truncate(detail, 180) : undefined,
    timestamp: event.timestamp,
    status: 'active',
  };
}

export function buildAgentContextSummary(
  messages: EnhancedMessage[],
): AgentContextSummary {
  const timeline: AgentTimelineItem[] = [];
  const seenTimelineIds = new Set<string>();
  let todos: AgentTodoItem[] = [];

  function pushTimeline(item: AgentTimelineItem): void {
    if (seenTimelineIds.has(item.id)) return;
    seenTimelineIds.add(item.id);
    timeline.push(item);
  }

  for (const message of messages) {
    if (message.type === 'system') {
      const issue = buildSystemIssueTimelineItem(message);
      if (issue) pushTimeline(issue);
      continue;
    }

    if (message.type !== 'tool_call') continue;

    const result = buildToolTimelineItem(message);
    if (result.item) {
      pushTimeline(result.item);
    }
    if (result.todos) {
      todos = result.todos;
    }
  }

  const orderedTimeline = timeline
    .map((item, index) => ({ index, item }))
    .sort((left, right) => {
      const byTimestamp = left.item.timestamp.localeCompare(right.item.timestamp);
      return byTimestamp || left.index - right.index;
    })
    .map(({ item }) => item);

  const commands = orderedTimeline.flatMap((item) => {
    const command = buildCommandItemFromTimeline(item);
    return command ? [command] : [];
  });
  const issuesAndPrompts = orderedTimeline.flatMap((item) =>
    item.kind === 'issue' ? [buildIssueItemFromTimeline(item)] : [],
  );

  return {
    referencedFiles: [],
    commands,
    verificationCommands: [],
    issuesAndPrompts,
    todos,
    timeline: orderedTimeline,
  };
}
