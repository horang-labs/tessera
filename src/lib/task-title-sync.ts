import * as dbSessions from '@/lib/db/sessions';
import * as dbTasks from '@/lib/db/tasks';

interface SingleSessionTitleLink {
  taskId: string;
  sessionId: string;
}

function getSingleSessionLinkByTaskId(taskId: string): SingleSessionTitleLink | null {
  const task = dbTasks.getTask(taskId);
  if (!task || task.sessions.length !== 1) return null;

  return {
    taskId,
    sessionId: task.sessions[0].id,
  };
}

function getSingleSessionLinkBySessionId(sessionId: string): SingleSessionTitleLink | null {
  const task = dbTasks.getTaskBySessionId(sessionId);
  if (!task || task.sessions.length !== 1) return null;

  return {
    taskId: task.id,
    sessionId: task.sessions[0].id,
  };
}

export function syncSingleSessionTaskTitleFromSession(sessionId: string, title: string): string | null {
  const link = getSingleSessionLinkBySessionId(sessionId);
  if (!link) return null;

  dbTasks.updateTask(link.taskId, { title });
  return link.taskId;
}

export function syncSingleSessionSessionTitleFromTask(
  taskId: string,
  title: string,
  options: { hasCustomTitle?: boolean; skipTimestamp?: boolean } = {}
): string | null {
  const link = getSingleSessionLinkByTaskId(taskId);
  if (!link) return null;

  dbSessions.updateSession(
    link.sessionId,
    {
      title,
      ...(options.hasCustomTitle !== undefined && {
        has_custom_title: options.hasCustomTitle ? 1 : 0,
      }),
    },
    { skipTimestamp: options.skipTimestamp }
  );

  return link.sessionId;
}
