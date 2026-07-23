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

/**
 * 정렬 anchor로 쓰는 불변 생성 시각.
 * task 항목은 TaskEntity.createdAt(DB 값)을 쓴다 — 어떤 세션이 "가장 최근"인지에 따라
 * item.session이 바뀌어도 흔들리지 않기 때문이다(taskToRecentItem의 liveSession,
 * fallbackTaskItemsFromSessions의 recentSession 모두 최신 세션을 따라 바뀔 수 있다).
 * chat 항목은 세션이 하나뿐이라 session.createdAt이 곧 불변 anchor다.
 */
function sortAnchorTime(item: RecentWorkItem): number {
  return timeValue(item.type === 'task' ? item.task.createdAt : item.session.createdAt);
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
    // 그룹의 정렬 anchor는 "가장 먼저 생성된 세션"의 createdAt으로 고정한다.
    // recentSession.createdAt을 쓰면 동시 실행 중인 세션끼리 최신 자리가 바뀔 때
    // anchor도 따라 바뀌어 정렬이 흔들린다.
    const earliestCreatedAt = sortedSessions.reduce(
      (earliest, session) =>
        timeValue(session.createdAt) < timeValue(earliest) ? session.createdAt : earliest,
      recentSession.createdAt,
    );
    const taskSessions: TaskSession[] = sortedSessions.map((session) => ({
      id: session.id,
      title: session.title,
      provider: session.provider,
      lastModified: session.lastModified,
      isRunning: session.isRunning,
      kind: session.kind,
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
      createdAt: earliestCreatedAt,
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
    .sort((left, right) => {
      // 1) 실행 중 항목을 위로 (사용자가 주시하는 라이브 작업).
      const runDiff = (right.isRunning ? 1 : 0) - (left.isRunning ? 1 : 0);
      if (runDiff !== 0) return runDiff;

      // 2) 같은 그룹 안에서는 키를 다르게 고른다.
      //    실행 중 세션은 스트리밍 청크마다 lastModified가 갱신되므로
      //    (touchSessionActivity, session-store.ts), lastActivityAt로 정렬하면
      //    동시에 스트리밍 중인 세션끼리 텍스트 델타마다 자리를 맞바꾼다.
      //    createdAt은 불변이라 실행 중 그룹의 순서가 흔들리지 않는다.
      //    완료된 항목은 lastActivityAt로 정렬해 실제 "최근 작업" 순서를 유지한다.
      //    (이 부분을 lastActivityAt로 되돌리면 정렬 흔들림 버그가 재발한다.)
      const leftKey = left.isRunning ? sortAnchorTime(left) : timeValue(left.lastActivityAt);
      const rightKey = right.isRunning ? sortAnchorTime(right) : timeValue(right.lastActivityAt);
      if (rightKey !== leftKey) return rightKey - leftKey;

      // 3) 키가 같을 때도 순서가 절대 뒤섞이지 않도록 결정적 tie-break.
      const createdDiff = sortAnchorTime(right) - sortAnchorTime(left);
      if (createdDiff !== 0) return createdDiff;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .slice(0, limit);
}
