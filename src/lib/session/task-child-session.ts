import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

export interface TaskChildSessionCreateResult {
  sessionId?: string;
  id?: string;
  title?: string;
  status?: UnifiedSession['status'];
  provider?: string;
  kind?: UnifiedSession['kind'];
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

export function buildTaskChildSession(
  task: TaskEntity,
  result: TaskChildSessionCreateResult,
  createdAt = new Date().toISOString(),
): UnifiedSession {
  const sessionId = result.sessionId?.trim() || result.id?.trim();
  if (!sessionId) {
    throw new Error('No session ID returned');
  }

  return {
    id: sessionId,
    title: result.title || 'New Session',
    projectDir: task.projectId || '',
    originProjectId: task.projectId,
    workDir: task.workDir,
    isRunning: false,
    hasStarted: false,
    status: result.status || 'starting',
    createdAt,
    lastModified: createdAt,
    archived: false,
    sortOrder: 0,
    worktreeBranch: task.worktreeBranch,
    taskId: task.id,
    collectionId: task.collectionId,
    provider: result.provider,
    kind: result.kind,
    model: result.model,
    reasoningEffort: result.reasoningEffort,
    serviceTier: result.serviceTier,
  };
}
