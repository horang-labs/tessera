import { create } from 'zustand';
import { useSessionStore } from './session-store';
import { useTaskStore } from './task-store';
import { toast } from './notification-store';

interface SelectionState {
  /** Set of selected session IDs */
  selectedIds: Set<string>;
  /** Last clicked session ID (anchor for Shift+Click range select) */
  lastClickedId: string | null;
  /** Most recently interacted session ID (for action bar positioning) */
  barAnchorId: string | null;

  // --- Actions ---

  /** Toggle a single session's selection (Ctrl/Cmd+Click) */
  toggleSelect: (id: string) => void;
  /** Range select from lastClickedId to targetId within a given ordered list */
  rangeSelect: (targetId: string, orderedIds: string[]) => void;
  /** Select all given IDs (replace current selection) */
  selectAll: (ids: string[]) => void;
  /** Clear all selections */
  clearSelection: () => void;

  // --- Bulk actions ---

  /** Mark all selected sessions as "done" */
  bulkMarkDone: () => Promise<void>;
  /** Archive all selected sessions */
  bulkArchive: () => Promise<void>;
  /** Delete all selected sessions */
  bulkDelete: () => Promise<void>;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selectedIds: new Set(),
  lastClickedId: null,
  barAnchorId: null,

  toggleSelect: (id) =>
    set((state) => {
      const next = new Set(state.selectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedIds: next, lastClickedId: id, barAnchorId: id };
    }),

  rangeSelect: (targetId, orderedIds) =>
    set((state) => {
      const anchor = state.lastClickedId;
      if (!anchor) {
        return { selectedIds: new Set([targetId]), lastClickedId: targetId, barAnchorId: targetId };
      }

      const anchorIdx = orderedIds.indexOf(anchor);
      const targetIdx = orderedIds.indexOf(targetId);

      if (anchorIdx === -1 || targetIdx === -1) {
        return { selectedIds: new Set([targetId]), lastClickedId: targetId, barAnchorId: targetId };
      }

      const start = Math.min(anchorIdx, targetIdx);
      const end = Math.max(anchorIdx, targetIdx);
      const next = new Set<string>();
      for (let i = start; i <= end; i++) {
        next.add(orderedIds[i]);
      }
      // Keep lastClickedId as original anchor, but move barAnchorId to target
      return { selectedIds: next, barAnchorId: targetId };
    }),

  selectAll: (ids) =>
    set({ selectedIds: new Set(ids), lastClickedId: null, barAnchorId: null }),

  clearSelection: () =>
    set({ selectedIds: new Set(), lastClickedId: null, barAnchorId: null }),

  bulkMarkDone: async () => {
    const { selectedIds } = get();
    if (selectedIds.size === 0) return;

    const sessionStore = useSessionStore.getState();
    const taskAnchors = new Set<string>();
    for (const id of selectedIds) {
      const session = sessionStore.getSession(id);
      if (!session?.taskId) continue;
      if (taskAnchors.has(session.taskId)) continue;
      taskAnchors.add(session.taskId);
      sessionStore.updateLinkedTaskWorkflowStatus(id, 'done');
    }
    set({ selectedIds: new Set(), lastClickedId: null, barAnchorId: null });
    toast.success(`${taskAnchors.size}개 작업을 완료로 이동했습니다`);
  },

  bulkArchive: async () => {
    const { selectedIds } = get();
    if (selectedIds.size === 0) return;

    const sessionStore = useSessionStore.getState();
    const taskIds = new Set<string>();
    const chatIds: string[] = [];
    for (const id of selectedIds) {
      const session = sessionStore.getSession(id);
      if (session?.taskId) {
        taskIds.add(session.taskId);
      } else {
        chatIds.push(id);
      }
    }
    for (const taskId of taskIds) {
      void useTaskStore.getState().toggleTaskArchive(taskId, true);
    }
    for (const id of chatIds) {
      sessionStore.toggleArchive(id, true);
    }
    set({ selectedIds: new Set(), lastClickedId: null, barAnchorId: null });
    toast.success(`${taskIds.size + chatIds.length}개 항목을 아카이브했습니다`);
  },

  bulkDelete: async () => {
    const { selectedIds } = get();
    if (selectedIds.size === 0) return;

    const ids = [...selectedIds];
    const failedIds: string[] = [];

    for (const id of ids) {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          useSessionStore.getState().removeSession(id);
        } else {
          failedIds.push(id);
        }
      } catch {
        failedIds.push(id);
      }
    }

    const successCount = ids.length - failedIds.length;
    if (failedIds.length > 0) {
      // Keep failed IDs selected so user can retry
      set({ selectedIds: new Set(failedIds), lastClickedId: null, barAnchorId: null });
      if (successCount > 0) {
        toast.warning(`${successCount}개 삭제 성공, ${failedIds.length}개 실패`);
      } else {
        toast.error(`삭제 실패: ${failedIds.length}개 세션을 삭제할 수 없습니다`);
      }
    } else {
      set({ selectedIds: new Set(), lastClickedId: null, barAnchorId: null });
      toast.success(`${successCount}개 세션을 삭제했습니다`);
    }
  },
}));
