import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

export type LinkedWorktreeDensity = 'standalone' | 'composite' | 'expanded';

/**
 * The caller must pass the Sessions already projected into the current Project
 * view. Branch-hidden history must never influence this presentation threshold.
 */
export function getLinkedWorktreeDensity(
  visibleSessions: ReadonlyArray<{ id: string }>,
): LinkedWorktreeDensity {
  if (visibleSessions.length === 0) return 'standalone';
  if (visibleSessions.length === 1) return 'composite';
  return 'expanded';
}

export function findCompositeWorktreeId(
  linkedWorktrees: ReadonlyArray<{
    worktreeId?: string;
    sessions: ReadonlyArray<{ id: string }>;
  }>,
  sessionId: string | null,
): string | null {
  if (!sessionId) return null;
  return linkedWorktrees.find(
    (worktree) => worktree.sessions.length === 1 && worktree.sessions[0]?.id === sessionId,
  )?.worktreeId ?? null;
}

export function toLinkedWorktreeSession(
  task: TaskEntity,
  session: TaskSession,
  canonicalSession?: UnifiedSession,
): UnifiedSession {
  const projection: UnifiedSession = {
    id: session.id,
    title: session.title,
    projectDir: task.projectViewId,
    originProjectId: session.originProjectId,
    isRunning: session.isRunning,
    status: session.isRunning ? 'running' : session.kind === 'terminal' ? 'stopped' : 'completed',
    lastModified: session.lastModified,
    createdAt: task.createdAt,
    kind: session.kind,
    workflowStatus: task.workflowStatus,
    worktreeBranch: task.worktreeBranch,
    worktreeId: task.worktreeId,
    workDir: task.workDir,
    archived: false,
    provider: session.provider,
    taskId: task.id,
    collectionId: task.collectionId,
    sortOrder: session.sortOrder,
  };
  if (!canonicalSession) return projection;

  return {
    ...projection,
    ...canonicalSession,
    projectDir: projection.projectDir,
    workflowStatus: projection.workflowStatus,
    worktreeBranch: projection.worktreeBranch,
    worktreeId: projection.worktreeId,
    workDir: projection.workDir,
    taskId: projection.taskId,
    collectionId: projection.collectionId,
    sortOrder: projection.sortOrder,
  };
}
