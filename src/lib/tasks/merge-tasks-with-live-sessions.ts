import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

// Display order is sortOrder, not recency: a new session is inserted at 0 and
// pushes the rest down, so the default reads as creation order, and a manual
// drag-reorder rewrites these values and therefore sticks.
function sortTaskSessionsByOrder(a: TaskSession, b: TaskSession): number {
  return a.sortOrder - b.sortOrder;
}

function toTaskSession(session: UnifiedSession): TaskSession {
  return {
    id: session.id,
    originProjectId: session.originProjectId,
    title: session.title,
    provider: session.provider,
    lastModified: session.lastModified,
    isRunning: session.isRunning,
    unreadCount: session.unreadCount,
    kind: session.kind,
    sortOrder: session.sortOrder,
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
    // Sort even without live sessions, so every task orders the same way.
    // Keep the original reference when the order already holds — the cards are
    // memoized on it, and a fresh object on every merge would defeat that.
    if (!liveSessions?.length) {
      const sorted = [...task.sessions].sort(sortTaskSessionsByOrder);
      const alreadySorted = sorted.every((session, index) => session === task.sessions[index]);
      return alreadySorted ? task : { ...task, sessions: sorted };
    }

    const mergedSessions = new Map<string, TaskSession>();
    for (const session of task.sessions) {
      mergedSessions.set(session.id, session);
    }
    for (const session of liveSessions) {
      mergedSessions.set(session.id, session);
    }

    return {
      ...task,
      sessions: Array.from(mergedSessions.values()).sort(sortTaskSessionsByOrder),
    };
  });
}
