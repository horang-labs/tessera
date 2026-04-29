import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

function sortTaskSessionsByLastModified(a: TaskSession, b: TaskSession): number {
  return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
}

function toTaskSession(session: UnifiedSession): TaskSession {
  return {
    id: session.id,
    title: session.title,
    provider: session.provider,
    lastModified: session.lastModified,
    isRunning: session.isRunning,
  };
}

export function mergeTasksWithLiveSessions(
  tasks: TaskEntity[],
  sessions: UnifiedSession[]
): TaskEntity[] {
  const liveSessionsByTaskId = new Map<string, TaskSession[]>();

  for (const session of sessions) {
    if (!session.taskId || session.archived) continue;

    const nextSessions = liveSessionsByTaskId.get(session.taskId) ?? [];
    nextSessions.push(toTaskSession(session));
    liveSessionsByTaskId.set(session.taskId, nextSessions);
  }

  return tasks.map((task) => {
    const liveSessions = liveSessionsByTaskId.get(task.id);
    if (!liveSessions?.length) return task;

    const mergedSessions = new Map<string, TaskSession>();
    for (const session of task.sessions) {
      mergedSessions.set(session.id, session);
    }
    for (const session of liveSessions) {
      mergedSessions.set(session.id, session);
    }

    return {
      ...task,
      sessions: Array.from(mergedSessions.values()).sort(sortTaskSessionsByLastModified),
    };
  });
}
