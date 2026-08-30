import { useCallback } from 'react';
import type React from 'react';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import type { TaskSession } from '@/types/task-entity';
import { captureTelemetryEvent } from '@/lib/telemetry/client';

/**
 * Drag-reorder for the sessions listed under a task, shared by the sidebar rows
 * and the kanban card. Order is persisted as `sort_order`, so a manual arrangement
 * outlives the default creation order.
 *
 * `sessions` must be the task's full list, not the capped slice — the reorder API
 * takes absolute positions, and sending only the visible rows would renumber them
 * over the hidden ones.
 */
export function useSubSessionReorder(taskId: string, sessions: TaskSession[]) {
  const draggingSubSession = useBoardStore((state) => state.draggingSubSession);
  const dropIndicator = useBoardStore((state) => state.subSessionDropIndicator);
  const setDragging = useBoardStore((state) => state.setDraggingSubSession);
  const setDropIndicator = useBoardStore((state) => state.setSubSessionDropIndicator);
  const reorderSessionsByIds = useSessionStore((state) => state.reorderSessionsByIds);

  // Only a row from this same task may reorder here; anything else keeps its
  // existing drop behavior (panel split, collection move).
  const isOwnDrag = draggingSubSession?.taskId === taskId;

  const handleDragStart = useCallback(
    (sessionId: string) => setDragging({ taskId, sessionId }),
    [setDragging, taskId],
  );

  const handleDragEnd = useCallback(() => setDragging(null), [setDragging]);

  const handleDragOver = useCallback(
    (event: React.DragEvent, targetSessionId: string) => {
      // Read through getState rather than the subscribed value: dragover can
      // fire before the render that would refresh this closure, and the stale
      // value would reject the drag as belonging to another task.
      const dragging = useBoardStore.getState().draggingSubSession;
      if (dragging?.taskId !== taskId || dragging.sessionId === targetSessionId) return;

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';

      const bounds = event.currentTarget.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      const current = useBoardStore.getState().subSessionDropIndicator;
      if (current?.targetSessionId !== targetSessionId || current.position !== position) {
        setDropIndicator({ targetSessionId, position });
      }
    },
    [taskId, setDropIndicator],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent, targetSessionId: string) => {
      const { draggingSubSession: dragging, subSessionDropIndicator: indicator } =
        useBoardStore.getState();
      const draggedId = dragging?.sessionId;
      if (dragging?.taskId !== taskId || !draggedId || draggedId === targetSessionId) return;

      event.preventDefault();
      event.stopPropagation();

      const position = indicator?.targetSessionId === targetSessionId
        ? indicator.position
        : 'before';

      const remaining = sessions.map((session) => session.id).filter((id) => id !== draggedId);
      const targetIndex = remaining.indexOf(targetSessionId);
      setDragging(null);
      if (targetIndex === -1) return;

      remaining.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId);
      reorderSessionsByIds(remaining);
      void captureTelemetryEvent('workspace_item_moved', {
        item_type: 'session',
        move_kind: 'reorder',
        item_count: 1,
      });
    },
    [taskId, sessions, setDragging, reorderSessionsByIds],
  );

  const indicatorFor = useCallback(
    (sessionId: string) =>
      isOwnDrag && dropIndicator?.targetSessionId === sessionId ? dropIndicator.position : null,
    [isOwnDrag, dropIndicator],
  );

  return {
    isDraggingSubSession: isOwnDrag,
    draggingSessionId: isOwnDrag ? draggingSubSession?.sessionId ?? null : null,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDrop,
    indicatorFor,
  };
}
