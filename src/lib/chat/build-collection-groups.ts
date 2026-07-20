import type { Collection } from '@/types/collection';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';

export interface CollectionGroupData {
  collectionId: string | null;
  tasks: TaskEntity[];
  chats: UnifiedSession[];
}

export function collectionGroupContainsSession(
  group: Pick<CollectionGroupData, 'tasks' | 'chats'>,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;

  return group.chats.some((chat) => chat.id === sessionId)
    || group.tasks.some((task) => task.sessions.some((session) => session.id === sessionId));
}

export function taskHasVisibleRuntimeSession(task: Pick<TaskEntity, 'sessions'>): boolean {
  return task.sessions.some((session) =>
    resolveSessionRuntimePresentation(session).showRunning
  );
}

export function collectionGroupRunningItemCount(
  group: Pick<CollectionGroupData, 'tasks' | 'chats'>,
): number {
  return group.chats.filter((session) =>
    resolveSessionRuntimePresentation(session).showRunning
  ).length + group.tasks.filter(taskHasVisibleRuntimeSession).length;
}

export function countRunningCollectionGroupItems(groups: CollectionGroupData[]): number {
  return groups.reduce((count, group) => count + collectionGroupRunningItemCount(group), 0);
}

export function getRunningCollectionGroupSessionIds(groups: CollectionGroupData[]): string[] {
  const sessionIds = new Set<string>();

  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) {
        if (resolveSessionRuntimePresentation(session).canStop) {
          sessionIds.add(session.id);
        }
      }
    }

    for (const chat of group.chats) {
      if (resolveSessionRuntimePresentation(chat).canStop) {
        sessionIds.add(chat.id);
      }
    }
  }

  return Array.from(sessionIds);
}

export function filterCollectionGroupsByRunning(groups: CollectionGroupData[]): CollectionGroupData[] {
  return groups
    .map((group) => ({
      collectionId: group.collectionId,
      tasks: group.tasks.filter(taskHasVisibleRuntimeSession),
      chats: group.chats.filter((session) =>
        resolveSessionRuntimePresentation(session).showRunning
      ),
    }))
    .filter((group) => group.tasks.length + group.chats.length > 0);
}

function createOrderedGroupMap(collections: Collection[]) {
  const groupMap = new Map<string | null, CollectionGroupData>();

  for (const collection of collections) {
    groupMap.set(collection.id, { collectionId: collection.id, tasks: [], chats: [] });
  }

  groupMap.set(null, { collectionId: null, tasks: [], chats: [] });

  return groupMap;
}

function orderCollectionGroups(
  groupMap: Map<string | null, CollectionGroupData>,
  collections: Collection[],
): CollectionGroupData[] {
  const result: CollectionGroupData[] = [];

  for (const collection of collections) {
    const group = groupMap.get(collection.id);
    if (group) result.push(group);
  }

  const uncategorized = groupMap.get(null);
  if (uncategorized) result.push(uncategorized);

  for (const [collectionId, group] of groupMap) {
    if (collectionId !== null && !collections.some((collection) => collection.id === collectionId)) {
      result.push(group);
    }
  }

  return result;
}

export function buildCollectionGroups(
  collections: Collection[],
  tasks: TaskEntity[],
  visibleSessions: UnifiedSession[],
): CollectionGroupData[] {
  const groupMap = createOrderedGroupMap(collections);
  const liveTasks = mergeTasksWithLiveSessions(tasks, visibleSessions);
  const knownTaskIds = new Set(liveTasks.map((task) => task.id));
  const visibleTaskIds = new Set(
    visibleSessions
      .map((session) => session.taskId)
      .filter((taskId): taskId is string => !!taskId && knownTaskIds.has(taskId))
  );

  for (const task of liveTasks) {
    if (!visibleTaskIds.has(task.id)) continue;

    const collectionId = task.collectionId ?? null;
    if (!groupMap.has(collectionId)) {
      groupMap.set(collectionId, { collectionId, tasks: [], chats: [] });
    }

    groupMap.get(collectionId)?.tasks.push(task);
  }

  for (const session of visibleSessions) {
    if (session.taskId && knownTaskIds.has(session.taskId)) continue;

    const collectionId = session.collectionId ?? null;
    if (!groupMap.has(collectionId)) {
      groupMap.set(collectionId, { collectionId, tasks: [], chats: [] });
    }

    groupMap.get(collectionId)?.chats.push(session);
  }

  for (const group of groupMap.values()) {
    group.tasks.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    group.chats.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  return orderCollectionGroups(groupMap, collections);
}

export function buildProjectCollectionGroups(
  project: ProjectGroup,
  collections: Collection[],
  tasks: TaskEntity[],
): CollectionGroupData[] {
  const visibleSessions = project.sessions.filter((session) => !session.archived);
  return buildCollectionGroups(collections, tasks, visibleSessions);
}
