import { taskHasVisibleRuntimeSession } from '@/lib/chat/build-collection-groups';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

interface KanbanRunningFilterInput {
  tasks: TaskEntity[];
  chats: UnifiedSession[];
}

export interface KanbanRunningItems {
  tasks: TaskEntity[];
  chats: UnifiedSession[];
  count: number;
}

/**
 * Select the card-level RUNNING projection for the current Kanban scope.
 * A linked Worktree counts once when any child Session is live; a standalone
 * Chat counts once for its own live runtime. Workflow placement is untouched.
 */
export function selectRunningKanbanItems({
  tasks,
  chats,
}: KanbanRunningFilterInput): KanbanRunningItems {
  const runningTasks = tasks.filter(taskHasVisibleRuntimeSession);
  const runningChats = chats.filter((session) =>
    resolveSessionRuntimePresentation(session).showRunning
  );

  return {
    tasks: runningTasks,
    chats: runningChats,
    count: runningTasks.length + runningChats.length,
  };
}
