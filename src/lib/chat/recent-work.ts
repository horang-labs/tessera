import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';

export type RecentWorkItem =
  | {
      type: 'chat';
      id: string;
      title: string;
      projectId: string;
      projectName: string;
      sessionIds: string[];
      session: UnifiedSession;
      lastActivityAt: string;
      isRunning: boolean;
      provider?: string;
    }
  | {
      type: 'task';
      id: string;
      title: string;
      projectId: string;
      projectName: string;
      sessionIds: string[];
      session: UnifiedSession;
      lastActivityAt: string;
      isRunning: boolean;
      provider?: string;
      task: TaskEntity;
      workflowStatus?: TaskEntity['workflowStatus'];
      worktreeBranch?: string;
      diffStats?: TaskEntity['diffStats'] | UnifiedSession['diffStats'];
    };

function timeValue(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getMostRecentTaskSession(sessions: TaskSession[]): TaskSession | null {
  let recent: TaskSession | null = null;
  for (const session of sessions) {
    if (!recent || timeValue(session.lastModified) > timeValue(recent.lastModified)) {
      recent = session;
    }
  }
  return recent;
}

function sortSessionsByLastActivity<T extends { lastModified: string }>(sessions: T[]): T[] {
  return [...sessions].sort((left, right) => timeValue(right.lastModified) - timeValue(left.lastModified));
}

function findProjectSession(project: ProjectGroup, sessionId: string): UnifiedSession | null {
  return project.sessions.find((session) => session.id === sessionId) ?? null;
}

function taskToRecentItem(project: ProjectGroup, task: TaskEntity): RecentWorkItem | null {
  if (task.archived || task.sessions.length === 0) return null;

  const recentSession = getMostRecentTaskSession(task.sessions);
  if (!recentSession) return null;

  const liveSession = findProjectSession(project, recentSession.id);
  const session: UnifiedSession = liveSession ?? {
    id: recentSession.id,
    title: recentSession.title,
    projectDir: project.encodedDir,
    isRunning: recentSession.isRunning,
    status: recentSession.isRunning ? 'running' : 'completed',
    lastModified: recentSession.lastModified,
    createdAt: task.createdAt,
    archived: false,
    sortOrder: task.sortOrder,
    provider: recentSession.provider,
    workflowStatus: task.workflowStatus,
    worktreeBranch: task.worktreeBranch,
    workDir: task.workDir,
    taskId: task.id,
    collectionId: task.collectionId,
  };

  return {
    type: 'task',
    id: task.id,
    title: task.title,
    projectId: project.encodedDir,
    projectName: project.displayName,
    sessionIds: task.sessions.map((item) => item.id),
    session,
    lastActivityAt: recentSession.lastModified || task.updatedAt,
    isRunning: task.sessions.some((item) => item.isRunning),
    provider: recentSession.provider,
    task,
    workflowStatus: task.workflowStatus,
    worktreeBranch: task.worktreeBranch,
    diffStats: task.diffStats ?? liveSession?.diffStats,
  };
}

function fallbackTaskItemsFromSessions(
  project: ProjectGroup,
  knownTaskIds: Set<string>,
): RecentWorkItem[] {
  const grouped = new Map<string, UnifiedSession[]>();

  for (const session of project.sessions) {
    if (session.archived || !session.taskId || knownTaskIds.has(session.taskId)) continue;
    const sessions = grouped.get(session.taskId) ?? [];
    sessions.push(session);
    grouped.set(session.taskId, sessions);
  }

  return Array.from(grouped.entries()).map(([taskId, sessions]) => {
    const sortedSessions = sortSessionsByLastActivity(sessions);
    const recentSession = sortedSessions[0];
    const taskSessions: TaskSession[] = sortedSessions.map((session) => ({
      id: session.id,
      title: session.title,
      provider: session.provider,
      lastModified: session.lastModified,
      isRunning: session.isRunning,
    }));
    const task: TaskEntity = {
      id: taskId,
      projectId: project.encodedDir,
      title: recentSession.title,
      collectionId: recentSession.collectionId,
      workflowStatus: recentSession.workflowStatus ?? 'todo',
      worktreeBranch: recentSession.worktreeBranch,
      workDir: recentSession.workDir,
      archived: false,
      sortOrder: recentSession.sortOrder,
      sessions: taskSessions,
      createdAt: recentSession.createdAt,
      updatedAt: recentSession.lastModified,
      diffStats: recentSession.diffStats,
    };

    return {
      type: 'task' as const,
      id: taskId,
      title: recentSession.title,
      projectId: project.encodedDir,
      projectName: project.displayName,
      sessionIds: sessions.map((session) => session.id),
      session: recentSession,
      lastActivityAt: recentSession.lastModified,
      isRunning: sessions.some((session) => session.isRunning),
      provider: recentSession.provider,
      task,
      workflowStatus: recentSession.workflowStatus,
      worktreeBranch: recentSession.worktreeBranch,
      diffStats: recentSession.diffStats,
    };
  });
}

function chatToRecentItem(project: ProjectGroup, session: UnifiedSession): RecentWorkItem | null {
  if (session.archived || session.taskId) return null;

  return {
    type: 'chat',
    id: session.id,
    title: session.title,
    projectId: project.encodedDir,
    projectName: project.displayName,
    sessionIds: [session.id],
    session,
    lastActivityAt: session.lastModified,
    isRunning: session.isRunning,
    provider: session.provider,
  };
}

export function buildRecentWorkItems({
  projects,
  tasksByProject,
  limit = 8,
}: {
  projects: ProjectGroup[];
  tasksByProject: Record<string, TaskEntity[]>;
  limit?: number;
}): RecentWorkItem[] {
  const items: RecentWorkItem[] = [];

  for (const project of projects) {
    const tasks = mergeTasksWithLiveSessions(tasksByProject[project.encodedDir] ?? [], project.sessions);
    const knownTaskIds = new Set(tasks.map((task) => task.id));

    for (const task of tasks) {
      const item = taskToRecentItem(project, task);
      if (item) items.push(item);
    }

    items.push(...fallbackTaskItemsFromSessions(project, knownTaskIds));

    for (const session of project.sessions) {
      const item = chatToRecentItem(project, session);
      if (item) items.push(item);
    }
  }

  return items
    .sort((left, right) => timeValue(right.lastActivityAt) - timeValue(left.lastActivityAt))
    .slice(0, limit);
}
