import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { resolveSessionWorktreeLifecycleTarget } from './session-worktree-lifecycle';
import type { SessionWorktreeLifecycleTask } from './session-worktree-lifecycle';

/**
 * Session-level UI entry points preserve independent child Sessions, while a
 * Worktree's last remaining Session follows the Worktree lifecycle.
 */
export function requestSessionArchive(
  sessionId: string,
  archived = true,
  taskSnapshot?: SessionWorktreeLifecycleTask,
): void {
  if (archived) {
    const task = taskSnapshot ?? projectViewWorkspaceState.resolveTaskBySessionId(sessionId);
    const target = resolveSessionWorktreeLifecycleTarget(sessionId, task);
    if (target.kind === 'worktree') {
      void useTaskStore.getState().toggleTaskArchive(target.taskId, true);
      return;
    }
  }
  useSessionStore.getState().toggleArchive(sessionId, archived);
}
