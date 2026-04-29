import { SESSION_DRAG_MIME } from '@/types/panel';
import { TASK_DND_MIME, TASK_ENTITY_DND_MIME } from '@/types/task';

/**
 * Add panel-split compatibility to a drag payload when it maps to a concrete session.
 */
export function setPanelSessionDragData(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
  return true;
}

/**
 * Kanban chat cards support both chat-column reorder and panel split.
 */
export function setKanbanChatDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  sessionId: string,
) {
  setPanelSessionDragData(dataTransfer, sessionId);
  dataTransfer.setData(TASK_DND_MIME, sessionId);
  dataTransfer.effectAllowed = 'move';
}

/**
 * Kanban task cards support both board task moves and panel split via the
 * task's primary session.
 */
export function setKanbanTaskDragData(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  taskId: string,
  primarySessionId: string | null | undefined,
) {
  dataTransfer.setData(TASK_ENTITY_DND_MIME, taskId);
  setPanelSessionDragData(dataTransfer, primarySessionId);
  dataTransfer.effectAllowed = 'move';
}
