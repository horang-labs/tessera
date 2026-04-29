export type ToolCallKind =
  | 'question_prompt'
  | 'shell_command'
  | 'file_read'
  | 'file_edit'
  | 'file_write'
  | 'search_grep'
  | 'search_glob'
  | 'subagent_task'
  | 'task_output'
  | 'task_stop'
  | 'web_search'
  | 'web_fetch'
  | 'todo_update';

/**
 * Compatibility fallback for legacy messages that predate canonical toolKind.
 * New provider mappers should set toolKind explicitly instead of relying on this.
 */
export function inferToolCallKindFromToolName(toolName: string): ToolCallKind | undefined {
  switch (toolName.toLowerCase()) {
    case 'askuserquestion':
      return 'question_prompt';
    case 'bash':
    case 'exec':
    case 'shell':
      return 'shell_command';
    case 'read':
      return 'file_read';
    case 'edit':
      return 'file_edit';
    case 'write':
    case 'write_file':
      return 'file_write';
    case 'grep':
      return 'search_grep';
    case 'glob':
      return 'search_glob';
    case 'task':
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
