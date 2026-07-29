/**
 * The terminal id a task's preparation runs under.
 *
 * Its own module because both sides need it: the server spawns the runtime
 * under this id, and a surface in the browser attaches to it by the same name.
 * Keyed on the task rather than the worktree path so that it survives a
 * worktree being moved, and so a client only needs the task to find the run.
 */
const PREPARATION_TERMINAL_PREFIX = 'preparation:';

export function getPreparationTerminalId(taskId: string): string {
  return `${PREPARATION_TERMINAL_PREFIX}${taskId}`;
}

/**
 * These runtimes are started by the server and only ever attached to by a
 * client, so a create request naming one that is not already running has
 * nothing to attach to and must not spawn a shell in its place.
 */
export function isPreparationTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(PREPARATION_TERMINAL_PREFIX);
}
