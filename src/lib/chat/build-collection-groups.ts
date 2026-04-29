import type { Collection } from '@/types/collection';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';

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
