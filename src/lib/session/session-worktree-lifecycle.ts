export interface SessionWorktreeLifecycleTask {
  id: string;
  worktreeId?: string;
  sessions: ReadonlyArray<{ id: string }>;
}

export type SessionWorktreeLifecycleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'worktree'; taskId: string; worktreeId: string };

/**
 * A Worktree Task with one remaining Session is one composite item in the UI.
 * Acting on that Session therefore acts on the whole Worktree. Once a Worktree
 * has siblings, each child remains independently archivable/deletable.
 */
export function resolveSessionWorktreeLifecycleTarget(
  sessionId: string,
  task: SessionWorktreeLifecycleTask | undefined,
): SessionWorktreeLifecycleTarget {
  if (
    task?.worktreeId
    && task.sessions.length === 1
    && task.sessions[0]?.id === sessionId
  ) {
    return { kind: 'worktree', taskId: task.id, worktreeId: task.worktreeId };
  }
  return { kind: 'session', sessionId };
}
