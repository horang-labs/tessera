import { normalizeToolResult } from '@/lib/tool-results/normalize-tool-result';
import type { AgentContextEvent, AgentContextStatus, AgentReferenceSource } from '@/types/agent-context';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';

interface BuildToolAgentContextEventsArgs {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
  status: 'running' | 'completed' | 'error';
  output?: string;
  error?: string;
  toolUseResult?: unknown;
}

const REFERENCE_PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'filepath',
  'file_paths',
  'paths',
  'path',
  'relative_path',
  'notebook_path',
]);

const READ_LIKE_SHELL_COMMANDS = new Set([
  'cat',
  'convert',
  'file',
  'head',
  'identify',
  'less',
  'magick',
  'sed',
  'tail',
  'tesseract',
]);

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

function normalizeToolResultSafely(toolKind: ToolCallKind | undefined, result: unknown): unknown {
  try {
    return normalizeToolResult(toolKind, result);
  } catch {
    return undefined;
  }
}

function isLikelyFilePath(value: string): boolean {
  const path = value.trim();
  if (!path || path === '.' || path === '..') return false;
  if (path.includes('*')) return false;
  if (path.endsWith('/')) return false;
  if (/^https?:\/\//.test(path)) return false;
  if (/^[A-Z_][A-Z0-9_]*=/.test(path)) return false;
  return path.includes('/') || /\.[A-Za-z0-9]{1,12}(?:\[[0-9]+\])?$/.test(path);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
}

function cleanShellPathToken(value: string): string {
  return value
    .trim()
    .replace(/^[<>"']+|[<>"',;:]+$/g, '')
    .replace(/\[[0-9]+\]$/, '');
}

function normalizeReferencedPath(value: string, cwd?: string): string | null {
  const cleaned = cleanShellPathToken(value);
  if (!isLikelyFilePath(cleaned)) return null;
  if (cleaned.startsWith('/tmp/') || cleaned.startsWith('~/tmp/')) return null;
  if (cleaned.startsWith('/')) return normalizeSlashes(cleaned);
  if (cleaned.startsWith('~')) return cleaned;
  return cwd ? normalizeSlashes(`${cwd}/${cleaned}`) : cleaned;
}

function addReferenceEvent(
  events: AgentContextEvent[],
  path: unknown,
  source: AgentReferenceSource,
  cwd?: string,
): void {
  if (Array.isArray(path)) {
    for (const item of path) addReferenceEvent(events, item, source, cwd);
    return;
  }
  if (typeof path !== 'string' || !path.trim()) return;

  const normalizedPath = normalizeReferencedPath(path, cwd);
  if (!normalizedPath) return;
  if (events.some((event) => event.kind === 'reference' && event.path === normalizedPath && event.source === source)) {
    return;
  }

  events.push({
    kind: 'reference',
    title: normalizedPath,
    path: normalizedPath,
    source,
    meta: source,
  });
}

function collectParamPathReferences(
  value: unknown,
  events: AgentContextEvent[],
  source: AgentReferenceSource,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectParamPathReferences(item, events, source);
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (REFERENCE_PATH_KEYS.has(key)) {
      addReferenceEvent(events, nestedValue, source);
      continue;
    }
    collectParamPathReferences(nestedValue, events, source);
  }
}

function collectReadLikeShellCommandReferences(
  command: unknown,
  events: AgentContextEvent[],
  cwd?: string,
): void {
  if (typeof command !== 'string') return;

  const unwrapped = command
    .replace(/^\/usr\/bin\/(?:ba|z|c|fi)?sh\s+-lc\s+/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  const firstWord = unwrapped.match(/^\s*(?:\S+\/)?([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase();
  if (!firstWord || !READ_LIKE_SHELL_COMMANDS.has(firstWord)) return;

  const tokenMatches = unwrapped.match(/(?:~?\/?[\w.@+-][\w.@+/\-[\]]*\.[A-Za-z0-9]{1,12}(?:\[[0-9]+\])?)/g) || [];
  for (const token of tokenMatches) {
    addReferenceEvent(events, token, 'inspect', cwd);
  }
}

function addResultReferences(
  result: unknown,
  events: AgentContextEvent[],
  source: AgentReferenceSource,
): void {
  if (!isRecord(result)) return;

  if (result.kind === 'file_read') {
    addReferenceEvent(events, result.path, 'read');
    return;
  }

  if (result.kind === 'search_result') {
    addReferenceEvent(events, result.files, source);
  }
}

function collectCommandActionReferences(
  toolParams: Record<string, any>,
  events: AgentContextEvent[],
  cwd?: string,
  fallbackCommand?: string,
): void {
  const actions = Array.isArray(toolParams.commandActions) ? toolParams.commandActions : [];

  for (const action of actions) {
    if (!isRecord(action)) continue;

    if (action.type === 'read') {
      addReferenceEvent(events, action.path, 'read', cwd);
      continue;
    }

    if (action.type === 'search' || action.type === 'listFiles') {
      addReferenceEvent(events, action.path, 'search', cwd);
      continue;
    }

    collectReadLikeShellCommandReferences(action.command, events, cwd);
  }

  if (actions.length === 0) {
    collectReadLikeShellCommandReferences(fallbackCommand, events, cwd);
  }
}

function getCommandText(args: BuildToolAgentContextEventsArgs): string {
  return args.toolDisplay?.shellCommand?.displayCommand
    || (typeof args.toolParams.command === 'string' ? args.toolParams.command : '')
    || (typeof args.toolParams.description === 'string' ? args.toolParams.description : '');
}

function getCommandCwd(args: BuildToolAgentContextEventsArgs): string | undefined {
  return args.toolDisplay?.shellCommand?.cwd
    || (typeof args.toolParams.cwd === 'string' ? args.toolParams.cwd : undefined);
}

function isVerificationCommand(command: string): boolean {
  return /\b(test|jest|vitest|playwright|cypress|lint|eslint|tsc|typecheck|build)\b/i.test(command);
}

function addTodoEvents(result: unknown, events: AgentContextEvent[]): void {
  if (!isRecord(result) || result.kind !== 'todo_update' || !Array.isArray(result.next)) return;

  for (const todo of result.next) {
    if (!isRecord(todo)) continue;
    if (todo.status !== 'pending' && todo.status !== 'in_progress') continue;
    const title = typeof todo.content === 'string' && todo.content.trim()
      ? todo.content
      : 'Untitled task';
    events.push({
      kind: 'todo',
      title,
      meta: todo.status.replace('_', ' '),
      status: todo.status,
    });
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return record ? nonEmptyString(record[key]) : undefined;
}

function recordNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function joinMeta(parts: Array<string | undefined>): string | undefined {
  const compact = parts.filter((part): part is string => Boolean(part));
  return compact.length > 0 ? compact.join(' | ') : undefined;
}

function formatDurationMs(value: number | undefined): string | undefined {
  if (typeof value !== 'number') return undefined;
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function getTaskParam(args: BuildToolAgentContextEventsArgs, key: string): string | undefined {
  return nonEmptyString(args.toolParams[key]);
}

function taskStatusFromToolStatus(status: BuildToolAgentContextEventsArgs['status']): AgentContextStatus {
  return status;
}

function getSubagentTaskStatus(
  argsStatus: BuildToolAgentContextEventsArgs['status'],
  phase: string | undefined,
  rawStatus: string | undefined,
): AgentContextStatus {
  if (argsStatus === 'error') return 'error';
  if (phase === 'started' || phase === 'async_started') return 'running';
  if (rawStatus === 'completed') return 'completed';
  if (rawStatus === 'failed') return 'error';
  if (rawStatus === 'cancelled') return 'warning';
  return taskStatusFromToolStatus(argsStatus);
}

function getBackgroundTaskStatus(
  argsStatus: BuildToolAgentContextEventsArgs['status'],
  retrievalStatus: string | undefined,
  taskStatus: string | undefined,
): AgentContextStatus {
  if (argsStatus === 'error' || retrievalStatus === 'error' || retrievalStatus === 'not_found') return 'error';
  if (taskStatus === 'running') return 'running';
  if (taskStatus === 'completed') return 'completed';
  if (taskStatus === 'failed') return 'error';
  return taskStatusFromToolStatus(argsStatus);
}

function addFallbackTaskEvent(
  args: BuildToolAgentContextEventsArgs,
  events: AgentContextEvent[],
): void {
  const title = getTaskParam(args, 'description')
    || getTaskParam(args, 'prompt')
    || args.toolName
    || 'Task';
  const detail = nonEmptyString(args.error) || nonEmptyString(args.output);
  const meta = joinMeta([
    getTaskParam(args, 'subagent_type'),
    getTaskParam(args, 'agentType'),
    getTaskParam(args, 'model'),
  ]);

  events.push({
    kind: 'task',
    title: truncate(title, 140),
    ...(detail ? { detail: truncate(detail, 180) } : {}),
    ...(meta ? { meta } : {}),
    status: taskStatusFromToolStatus(args.status),
  });
}

function addSubagentTaskEvents(
  args: BuildToolAgentContextEventsArgs,
  result: unknown,
  events: AgentContextEvent[],
): void {
  if (!isRecord(result) || result.kind !== 'subagent_task') {
    addFallbackTaskEvent(args, events);
    return;
  }

  const phase = recordString(result, 'phase');
  const rawStatus = recordString(result, 'status');
  const prompt = recordString(result, 'prompt') || getTaskParam(args, 'prompt');
  const description = recordString(result, 'description') || getTaskParam(args, 'description');
  const responseText = recordString(result, 'responseText');
  const agentId = recordString(result, 'agentId');
  const agentType = recordString(result, 'agentType')
    || getTaskParam(args, 'subagent_type')
    || getTaskParam(args, 'agentType');
  const model = recordString(result, 'model') || getTaskParam(args, 'model');
  const outputFile = recordString(result, 'outputFile');
  const metrics = isRecord(result['metrics']) ? result['metrics'] : undefined;
  const duration = formatDurationMs(recordNumber(metrics, 'totalDurationMs'));
  const toolUseCount = recordNumber(metrics, 'totalToolUseCount');
  const totalTokens = recordNumber(metrics, 'totalTokens');
  const title = description || prompt || (agentId ? `Task ${agentId}` : args.toolName || 'Task');
  const detail = phase === 'completed'
    ? responseText || prompt
    : prompt || responseText;
  const meta = joinMeta([
    phase ? phase.replace('_', ' ') : undefined,
    agentType,
    agentId,
    model,
    result['runInBackground'] === true ? 'background' : undefined,
    duration,
    typeof toolUseCount === 'number' ? `${toolUseCount} tools` : undefined,
    typeof totalTokens === 'number' ? `${totalTokens} tok` : undefined,
    outputFile,
  ]);

  events.push({
    kind: 'task',
    title: truncate(title, 140),
    ...(detail ? { detail: truncate(detail, 180) } : {}),
    ...(meta ? { meta } : {}),
    status: getSubagentTaskStatus(args.status, phase, rawStatus),
  });
}

function addBackgroundTaskEvents(
  args: BuildToolAgentContextEventsArgs,
  result: unknown,
  events: AgentContextEvent[],
): void {
  if (!isRecord(result) || result.kind !== 'background_task') {
    addFallbackTaskEvent(args, events);
    return;
  }

  const action = recordString(result, 'action');
  const task = isRecord(result['task']) ? result['task'] : undefined;
  const taskId = recordString(task, 'id');
  const taskType = recordString(task, 'type');

  if (action === 'output') {
    const description = recordString(task, 'description');
    const prompt = recordString(task, 'prompt');
    const output = recordString(task, 'result') || recordString(task, 'output');
    const retrievalStatus = recordString(result, 'retrievalStatus');
    const taskStatus = recordString(task, 'status');
    const exitCode = recordNumber(task, 'exitCode');
    const title = description || prompt || (taskId ? `Task output ${taskId}` : args.toolName || 'Task output');
    const meta = joinMeta([
      action,
      taskId,
      taskType,
      retrievalStatus,
      typeof exitCode === 'number' ? `exit ${exitCode}` : undefined,
    ]);

    events.push({
      kind: 'task',
      title: truncate(title, 140),
      ...(output ? { detail: truncate(output, 180) } : {}),
      ...(meta ? { meta } : {}),
      status: getBackgroundTaskStatus(args.status, retrievalStatus, taskStatus),
    });
    return;
  }

  if (action === 'stop') {
    const message = recordString(result, 'message');
    const command = recordString(result, 'command');
    const meta = joinMeta([action, taskId, taskType]);

    events.push({
      kind: 'task',
      title: truncate(message || (taskId ? `Stop task ${taskId}` : args.toolName || 'Stop task'), 140),
      ...(command ? { detail: truncate(command, 180) } : {}),
      ...(meta ? { meta } : {}),
      status: args.status === 'error' ? 'error' : 'completed',
    });
    return;
  }

  addFallbackTaskEvent(args, events);
}

export function buildToolAgentContextEvents(args: BuildToolAgentContextEventsArgs): AgentContextEvent[] {
  const events: AgentContextEvent[] = [];
  const normalizedResult = normalizeToolResultSafely(args.toolKind, args.toolUseResult);

  if (args.toolKind === 'shell_command') {
    const command = getCommandText(args).trim();
    const cwd = getCommandCwd(args);
    if (command) {
      events.push({
        kind: isVerificationCommand(command) ? 'verification' : 'command',
        title: command,
        command,
        ...(cwd ? { meta: cwd } : {}),
        status: args.status,
        ...(args.status === 'error'
          ? { detail: truncate(args.error || args.output || 'Command failed', 180) }
          : {}),
      });
    }
    collectCommandActionReferences(args.toolParams, events, cwd, command);
  } else if (args.toolKind === 'file_read') {
    collectParamPathReferences(args.toolParams, events, 'read');
    addResultReferences(normalizedResult, events, 'read');
  } else if (args.toolKind === 'search_grep' || args.toolKind === 'search_glob') {
    collectParamPathReferences(args.toolParams, events, 'search');
    addResultReferences(normalizedResult, events, 'search');
  } else if (args.toolKind === 'subagent_task') {
    addSubagentTaskEvents(args, normalizedResult, events);
  } else if (args.toolKind === 'task_output' || args.toolKind === 'task_stop') {
    addBackgroundTaskEvents(args, normalizedResult, events);
  } else if (args.toolKind === 'todo_update') {
    addTodoEvents(normalizedResult, events);
  }

  if (args.status === 'error') {
    events.push({
      kind: 'issue',
      title: args.toolName,
      detail: truncate(args.error || args.output || 'Tool call failed', 180),
      status: 'error',
    });
  }

  return events;
}
