import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

export type CollectionIndicatorStatus = 'running' | 'processing' | 'unread' | 'awaiting-user';

export interface CollectionSessionSnapshot {
  id: string;
  isRunning: boolean;
  unreadCount?: number;
  kind?: 'chat' | 'terminal';
}

export interface CollectionStatusFlags {
  hasVisibleRuntimeSession: boolean;
  hasProcessingSession: boolean;
  hasTerminalProcessingSession: boolean;
  hasUnreadSession: boolean;
  hasAwaitingUserSession: boolean;
}

export function getCollectionSessionSnapshots(
  tasks: Pick<TaskEntity, 'sessions'>[],
  chats: Pick<UnifiedSession, 'id' | 'isRunning' | 'unreadCount' | 'kind'>[],
): CollectionSessionSnapshot[] {
  const snapshots: CollectionSessionSnapshot[] = [];

  for (const task of tasks) {
    for (const session of task.sessions) {
      snapshots.push({
        id: session.id,
        isRunning: session.isRunning,
        kind: session.kind,
      });
    }
  }

  for (const chat of chats) {
    snapshots.push({
      id: chat.id,
      isRunning: chat.isRunning,
      unreadCount: chat.unreadCount,
      kind: chat.kind,
    });
  }

  return snapshots;
}

export function getPrioritizedCollectionIndicatorStatus({
  hasVisibleRuntimeSession,
  hasProcessingSession,
  hasTerminalProcessingSession,
  hasUnreadSession,
  hasAwaitingUserSession,
}: CollectionStatusFlags): CollectionIndicatorStatus | null {
  if (hasAwaitingUserSession) return 'awaiting-user';
  if (hasTerminalProcessingSession) return 'processing';
  if (hasUnreadSession) return 'unread';
  if (hasProcessingSession) return 'processing';
  if (hasVisibleRuntimeSession) return 'running';
  return null;
}
