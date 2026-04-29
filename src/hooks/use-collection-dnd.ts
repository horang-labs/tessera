'use client';

import { useCallback } from 'react';
import type React from 'react';
import { useBoardStore } from '@/stores/board-store';
import { useTaskStore } from '@/stores/task-store';
import { useSessionStore } from '@/stores/session-store';
import { useSelectionStore } from '@/stores/selection-store';
import { useCollectionStore } from '@/stores/collection-store';
import { COLLECTION_ITEM_DND_MIME, COLLECTION_GROUP_DND_MIME, TASK_MULTI_DND_MIME } from '@/types/task';
import { setPanelSessionDragData } from '@/lib/dnd/panel-session-drag';

/**
 * useCollectionDnd
 *
 * HTML5 Drag & Drop for the collection-based sidebar list view.
 *
 * Two DnD modes:
 * 1. Item DnD: drag tasks/chats between collections (COLLECTION_ITEM_DND_MIME)
 * 2. Group DnD: reorder collection groups (COLLECTION_GROUP_DND_MIME)
 *
 * Also sets SESSION_DRAG_MIME for panel-split compatibility when the dragged
 * item resolves to a concrete session (chat rows and task primary sessions).
 */

// Module-level state for custom drag overlay
let dragOverlay: HTMLElement | null = null;
let dragMoveHandler: ((e: DragEvent) => void) | null = null;

let emptyDragEl: HTMLElement | null = null;
function getEmptyDragElement(): HTMLElement {
  if (!emptyDragEl) {
    emptyDragEl = document.createElement('div');
    emptyDragEl.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0.01';
    document.body.appendChild(emptyDragEl);
  }
  return emptyDragEl;
}

function cleanupOverlay() {
  if (dragOverlay?.parentNode) dragOverlay.parentNode.removeChild(dragOverlay);
  dragOverlay = null;
  if (dragMoveHandler) {
    document.removeEventListener('dragover', dragMoveHandler);
    dragMoveHandler = null;
  }
}

function buildCollectionScopeId(projectId: string, collectionId: string | null): string {
  return `${projectId}::${collectionId ?? '__uncategorized'}`;
}

export interface UseCollectionDndReturn {
  // Item DnD
  draggingItem: { type: 'task' | 'chat'; id: string; collectionId: string | null; projectId: string } | null;
  dragOverCollectionId: string | null;
  collectionDropIndicator: { targetId: string; position: 'before' | 'after' } | null;
  handleItemDragStart: (
    type: 'task' | 'chat',
    id: string,
    collectionId: string | null,
    projectId: string,
    e: React.DragEvent
  ) => void;
  handleItemDragEnd: (e: React.DragEvent) => void;
  handleCollectionDragOver: (collectionScopeId: string, projectId: string, e: React.DragEvent) => void;
  handleCollectionDragLeave: (collectionScopeId: string, projectId: string, e: React.DragEvent) => void;
  handleCollectionDrop: (targetCollectionId: string | null, projectId: string, e: React.DragEvent) => void;
  handleItemDragOverItem: (
    targetId: string,
    collectionScopeId: string,
    targetType: 'task' | 'chat',
    projectId: string,
    e: React.DragEvent
  ) => void;

  // Group DnD
  draggingGroupId: string | null;
  groupDragOverIndex: number | null;
  handleGroupDragStart: (
    groupScopeId: string,
    collectionId: string | null,
    projectId: string,
    e: React.DragEvent
  ) => void;
  handleGroupDragEnd: (e: React.DragEvent) => void;
  handleGroupDragOver: (index: number, e: React.DragEvent) => void;
  handleGroupDragLeave: (index: number, e: React.DragEvent) => void;
  handleGroupDrop: (projectId: string, targetIndex: number, e: React.DragEvent) => void;
}

export function useCollectionDnd(): UseCollectionDndReturn {
  // Reactive subscriptions
  const draggingItem = useBoardStore((s) => s.draggingCollectionItem);
  const dragOverCollectionId = useBoardStore((s) => s.dragOverCollectionId);
  const collectionDropIndicator = useBoardStore((s) => s.collectionDropIndicator);
  const draggingGroupId = useBoardStore((s) => s.draggingCollectionGroupId);
  const groupDragOverIndex = useBoardStore((s) => s.collectionGroupDragOverIndex);

  // ─── Item DnD ──────────────────────────────────────────────────────

  const handleItemDragStart = useCallback((
    type: 'task' | 'chat',
    id: string,
    collectionId: string | null,
    projectId: string,
    e: React.DragEvent,
  ) => {
    const selStore = useSelectionStore.getState();
    // For tasks, the selection store uses session IDs — resolve the primary session ID for matching
    const sessionId = type === 'chat' ? id : (() => {
      const task = useTaskStore.getState().getTask(id);
      return task?.sessions[0]?.id ?? null;
    })();
    const isMulti = selStore.selectedIds.size > 1 && sessionId != null && selStore.selectedIds.has(sessionId);

    // If dragging a non-selected item, clear selection (standard Finder behavior)
    if (selStore.selectedIds.size > 0 && sessionId && !selStore.selectedIds.has(sessionId)) {
      selStore.clearSelection();
    }

    const payload = JSON.stringify({ type, id, collectionId, projectId });
    e.dataTransfer.setData(COLLECTION_ITEM_DND_MIME, payload);

    // Panel-split compat for chat rows and task primary sessions
    setPanelSessionDragData(e.dataTransfer, sessionId);
    // Store all selected IDs in dataTransfer for multi-DnD
    if (isMulti) {
      e.dataTransfer.setData(TASK_MULTI_DND_MIME, JSON.stringify([...selStore.selectedIds]));
    }
    e.dataTransfer.effectAllowed = 'move';

    // Suppress browser ghost
    e.dataTransfer.setDragImage(getEmptyDragElement(), 0, 0);

    // Create opaque overlay clone
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as HTMLElement;
    const computed = getComputedStyle(el);

    const SCALE = 0.7;
    const scaledW = rect.width * SCALE;
    const scaledH = rect.height * SCALE;
    clone.style.cssText = `
      position:fixed; width:${rect.width}px; height:${rect.height}px;
      left:${e.clientX + 12}px; top:${e.clientY + 8}px;
      opacity:0.85; transform:rotate(1.5deg) scale(${SCALE});
      transform-origin:top left;
      box-shadow:0 12px 32px rgba(0,0,0,0.25),0 0 0 1.5px rgba(13,148,136,0.3);
      border-radius:10px; pointer-events:none; z-index:99999; transition:none;
      background-color:${computed.backgroundColor};
    `;
    clone.removeAttribute('data-testid');

    // Multi-select: stack selected cards with count badge
    if (isMulti) {
      const selectedIds = [...selStore.selectedIds];
      const refBg = computed.backgroundColor;

      const clones: { node: HTMLElement; w: number; h: number }[] = [];
      for (const sid of selectedIds.slice(0, 5)) {
        const srcEl = document.querySelector(`[data-session-id="${CSS.escape(sid)}"]`) as HTMLElement | null;
        if (!srcEl) continue;
        const srcRect = srcEl.getBoundingClientRect();
        const srcClone = srcEl.cloneNode(true) as HTMLElement;
        srcClone.style.width = `${srcRect.width}px`;
        srcClone.style.height = `${srcRect.height}px`;
        srcClone.style.borderRadius = '10px';
        srcClone.style.backgroundColor = refBg;
        srcClone.style.opacity = '1';
        srcClone.style.pointerEvents = 'none';
        srcClone.style.transition = 'none';
        srcClone.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)';
        srcClone.removeAttribute('data-testid');
        clones.push({ node: srcClone, w: srcRect.width, h: srcRect.height });
      }

      if (clones.length === 0) {
        document.body.appendChild(clone);
        dragOverlay = clone;
      } else {
        const wrapper = document.createElement('div');
        wrapper.style.position = 'fixed';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.zIndex = '99999';
        wrapper.style.transform = `scale(${SCALE})`;
        wrapper.style.transformOrigin = 'top left';
        wrapper.style.opacity = '0.85';
        wrapper.style.left = `${e.clientX + 12}px`;
        wrapper.style.top = `${e.clientY + 8}px`;

        const OFFSET_Y = 32;
        const OFFSET_X = 4;
        for (let i = clones.length - 1; i >= 0; i--) {
          const c = clones[i];
          c.node.style.position = i === 0 ? 'relative' : 'absolute';
          c.node.style.left = `${i * OFFSET_X}px`;
          c.node.style.top = `${i * OFFSET_Y}px`;
          wrapper.appendChild(c.node);
        }

        const badge = document.createElement('div');
        badge.textContent = String(selectedIds.length);
        badge.style.cssText = `
          position:absolute; top:-10px; right:-10px; min-width:26px; height:26px;
          border-radius:13px; background:rgb(13,148,136); color:white;
          font-size:13px; font-weight:700; display:flex; align-items:center;
          justify-content:center; padding:0 7px;
          box-shadow:0 2px 8px rgba(0,0,0,0.4), 0 0 0 2px rgba(255,255,255,0.15);
        `;
        wrapper.appendChild(badge);

        document.body.appendChild(wrapper);
        dragOverlay = wrapper;
      }
    } else {
      document.body.appendChild(clone);
      dragOverlay = clone;
    }

    // Follow cursor — offset so the card trails below-right, keeping drop targets visible
    const CURSOR_OFFSET_X = 12;
    const CURSOR_OFFSET_Y = 8;
    dragMoveHandler = (ev: DragEvent) => {
      if (ev.clientX === 0 && ev.clientY === 0) return;
      if (dragOverlay) {
        dragOverlay.style.left = `${ev.clientX + CURSOR_OFFSET_X}px`;
        dragOverlay.style.top = `${ev.clientY + CURSOR_OFFSET_Y}px`;
      }
    };
    document.addEventListener('dragover', dragMoveHandler);

    // Defer state update (same Chromium bug workaround as useTaskDnd)
    requestAnimationFrame(() => {
      useBoardStore.getState().setDraggingCollectionItem({ type, id, collectionId, projectId });
    });
  }, []);

  const handleItemDragEnd = useCallback((_e: React.DragEvent) => {
    cleanupOverlay();
    useBoardStore.getState().setDraggingCollectionItem(null);
  }, []);

  const handleCollectionDragOver = useCallback((collectionScopeId: string, projectId: string, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(COLLECTION_ITEM_DND_MIME)) return;
    const dragging = useBoardStore.getState().draggingCollectionItem;
    if (dragging && dragging.projectId !== projectId) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'none';
      if (useBoardStore.getState().dragOverCollectionId === collectionScopeId) {
        useBoardStore.getState().setDragOverCollection(null);
      }
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const current = useBoardStore.getState().dragOverCollectionId;
    if (current !== collectionScopeId) {
      useBoardStore.getState().setDragOverCollection(collectionScopeId);
    }
  }, []);

  const handleCollectionDragLeave = useCallback((collectionScopeId: string, _projectId: string, e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    const current = useBoardStore.getState().dragOverCollectionId;
    if (current === collectionScopeId) {
      useBoardStore.getState().setDragOverCollection(null);
    }
  }, []);

  /** Per-item dragover for within-collection reorder positioning.
   *  Only shows indicator for same-collection, same-type reorder.
   *  Cross-type (task↔chat) shows not-allowed cursor. */
  const handleItemDragOverItem = useCallback((
    targetId: string,
    targetCollectionScopeId: string,
    targetType: 'task' | 'chat',
    projectId: string,
    e: React.DragEvent,
  ) => {
    if (!e.dataTransfer.types.includes(COLLECTION_ITEM_DND_MIME)) return;

    const dragging = useBoardStore.getState().draggingCollectionItem;
    if (!dragging || dragging.id === targetId) {
      if (useBoardStore.getState().collectionDropIndicator) {
        useBoardStore.getState().setCollectionDropIndicator(null);
      }
      return;
    }

    if (dragging.projectId !== projectId) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'none';
      if (useBoardStore.getState().collectionDropIndicator) {
        useBoardStore.getState().setCollectionDropIndicator(null);
      }
      return;
    }

    // Cross-type drag (task↔chat): show not-allowed cursor
    const sourceScopeId = buildCollectionScopeId(dragging.projectId, dragging.collectionId);
    if (sourceScopeId === targetCollectionScopeId && dragging.type !== targetType) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'none';
      if (useBoardStore.getState().collectionDropIndicator) {
        useBoardStore.getState().setCollectionDropIndicator(null);
      }
      return;
    }

    // Cross-collection drag: no position indicator (just move to collection)
    if (sourceScopeId !== targetCollectionScopeId) {
      if (useBoardStore.getState().collectionDropIndicator) {
        useBoardStore.getState().setCollectionDropIndicator(null);
      }
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';

    const current = useBoardStore.getState().collectionDropIndicator;
    if (current?.targetId !== targetId || current?.position !== position) {
      useBoardStore.getState().setCollectionDropIndicator({ targetId, position });
    }
  }, []);

  const handleCollectionDrop = useCallback((targetCollectionId: string | null, targetProjectId: string, e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes(COLLECTION_ITEM_DND_MIME)) return;

    cleanupOverlay();

    const raw = e.dataTransfer.getData(COLLECTION_ITEM_DND_MIME);
    if (!raw) {
      useBoardStore.getState().setDraggingCollectionItem(null);
      return;
    }

    const { type, id, collectionId: sourceCollectionId, projectId: sourceProjectId } = JSON.parse(raw) as {
      type: 'task' | 'chat';
      id: string;
      collectionId: string | null;
      projectId: string;
    };

    if (sourceProjectId !== targetProjectId) {
      useBoardStore.getState().setDraggingCollectionItem(null);
      useBoardStore.getState().setDragOverCollection(null);
      useBoardStore.getState().setCollectionDropIndicator(null);
      return;
    }

    // Check for multi-select drop
    const multiData = e.dataTransfer.getData(TASK_MULTI_DND_MIME);
    const multiSessionIds: string[] = multiData ? JSON.parse(multiData) : [];
    const isMulti = multiSessionIds.length > 1;

    const indicator = useBoardStore.getState().collectionDropIndicator;

    if (isMulti && sourceCollectionId !== targetCollectionId) {
      // Multi-select: move all selected items to target collection (optimistic)
      const taskStore = useTaskStore.getState();

      for (const sessionId of multiSessionIds) {
        const session = useSessionStore.getState().getSession(sessionId);
        if (session && session.projectDir !== targetProjectId) continue;

        const task = taskStore.getTaskBySessionId(sessionId);
        if (task) {
          taskStore.updateTask(task.id, { collectionId: targetCollectionId });
        } else {
          useSessionStore.getState().updateSessionCollection(sessionId, targetCollectionId);
        }
      }
      useSelectionStore.getState().clearSelection();
      useBoardStore.getState().flashDrop(id);
    } else if (sourceCollectionId !== targetCollectionId) {
      // Single-item move to different collection (optimistic)
      if (type === 'task') {
        useTaskStore.getState().updateTask(id, { collectionId: targetCollectionId });
      } else {
        useSessionStore.getState().updateSessionCollection(id, targetCollectionId);
      }
      useBoardStore.getState().flashDrop(id);
    } else if (indicator) {
      // Same collection — reorder within collection
      if (type === 'task') {
        const taskStore = useTaskStore.getState();
        const draggingTask = taskStore.getTask(id);
        if (!draggingTask) {
          useBoardStore.getState().setDraggingCollectionItem(null);
          useBoardStore.getState().setDragOverCollection(null);
          useBoardStore.getState().setCollectionDropIndicator(null);
          return;
        }

        const colTasks = taskStore
          .getTasksForProject(draggingTask.projectId)
          .filter((t) => (t.collectionId ?? null) === (targetCollectionId ?? null))
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        const ids = colTasks.map((t) => t.id);
        const filtered = ids.filter((tid) => tid !== id);
        const targetIdx = filtered.indexOf(indicator.targetId);
        if (targetIdx !== -1) {
          const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
          filtered.splice(insertIdx, 0, id);
          taskStore.reorderTasks(filtered, draggingTask.projectId);
          useBoardStore.getState().flashDrop(id);
        }
      } else {
        // Chat session reorder
        const sessionStore = useSessionStore.getState();
        const project = sessionStore.projects.find((p) => p.encodedDir === targetProjectId);
        if (project) {
          const colChats = project.sessions
            .filter((s) => !s.archived && (s.collectionId ?? null) === (targetCollectionId ?? null) && !s.taskId)
            .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          const ids = colChats.map((s) => s.id);
          const filtered = ids.filter((sid) => sid !== id);
          const targetIdx = filtered.indexOf(indicator.targetId);
          if (targetIdx !== -1) {
            const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
            filtered.splice(insertIdx, 0, id);
            sessionStore.reorderSessionsByIds(filtered);
            useBoardStore.getState().flashDrop(id);
          }
        }
      }
    }

    // Clear selection after multi-drop
    if (isMulti) {
      useSelectionStore.getState().clearSelection();
    }

    // Reset state
    useBoardStore.getState().setDraggingCollectionItem(null);
    useBoardStore.getState().setDragOverCollection(null);
    useBoardStore.getState().setCollectionDropIndicator(null);
  }, []);

  // ─── Group DnD ─────────────────────────────────────────────────────

  const handleGroupDragStart = useCallback((
    groupScopeId: string,
    collectionId: string | null,
    projectId: string,
    e: React.DragEvent
  ) => {
    e.dataTransfer.setData(
      COLLECTION_GROUP_DND_MIME,
      JSON.stringify({ collectionId, projectId })
    );
    e.dataTransfer.effectAllowed = 'move';
    useBoardStore.getState().setDraggingCollectionGroup(groupScopeId);
  }, []);

  const handleGroupDragEnd = useCallback((_e: React.DragEvent) => {
    useBoardStore.getState().setDraggingCollectionGroup(null);
    useBoardStore.getState().setCollectionGroupDragOverIndex(null);
  }, []);

  const handleGroupDragOver = useCallback((index: number, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(COLLECTION_GROUP_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const current = useBoardStore.getState().collectionGroupDragOverIndex;
    if (current !== index) {
      useBoardStore.getState().setCollectionGroupDragOverIndex(index);
    }
  }, []);

  const handleGroupDragLeave = useCallback((index: number, e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    const current = useBoardStore.getState().collectionGroupDragOverIndex;
    if (current === index) {
      useBoardStore.getState().setCollectionGroupDragOverIndex(null);
    }
  }, []);

  const handleGroupDrop = useCallback((targetProjectId: string, targetIndex: number, e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes(COLLECTION_GROUP_DND_MIME)) return;

    const rawPayload = e.dataTransfer.getData(COLLECTION_GROUP_DND_MIME);
    if (!rawPayload) return;

    const { collectionId: draggedCollectionId, projectId: sourceProjectId } = JSON.parse(rawPayload) as {
      collectionId: string | null;
      projectId: string;
    };

    if (sourceProjectId !== targetProjectId) {
      useBoardStore.getState().setDraggingCollectionGroup(null);
      useBoardStore.getState().setCollectionGroupDragOverIndex(null);
      return;
    }

    const collections = useCollectionStore.getState().getCollectionsForProject(targetProjectId);
    const fromIndex = draggedCollectionId === null
      ? collections.length // uncategorized is always last
      : collections.findIndex((c) => c.id === draggedCollectionId);

    if (fromIndex === -1 || fromIndex === targetIndex) {
      useBoardStore.getState().setDraggingCollectionGroup(null);
      useBoardStore.getState().setCollectionGroupDragOverIndex(null);
      return;
    }

    // Reorder collections via API (sortOrder update)
    const ordered = [...collections];
    const [moved] = ordered.splice(fromIndex, 1);
    if (moved) {
      ordered.splice(targetIndex, 0, moved);
      // Update sortOrder for all collections
      const updates = ordered.map((c, i) => ({
        id: c.id,
        sortOrder: i,
      }));
      // Optimistic: update store immediately
      useCollectionStore.getState().setCollectionsForProject(
        targetProjectId,
        ordered.map((c, i) => ({ ...c, sortOrder: i }))
      );
      // Persist (fire-and-forget — server reorders)
      for (const u of updates) {
        fetch(`/api/collections/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sortOrder: u.sortOrder }),
        });
      }
    }

    useBoardStore.getState().setDraggingCollectionGroup(null);
    useBoardStore.getState().setCollectionGroupDragOverIndex(null);
  }, []);

  return {
    draggingItem,
    dragOverCollectionId,
    collectionDropIndicator,
    handleItemDragStart,
    handleItemDragEnd,
    handleCollectionDragOver,
    handleCollectionDragLeave,
    handleCollectionDrop,
    handleItemDragOverItem,

    draggingGroupId,
    groupDragOverIndex,
    handleGroupDragStart,
    handleGroupDragEnd,
    handleGroupDragOver,
    handleGroupDragLeave,
    handleGroupDrop,
  };
}
