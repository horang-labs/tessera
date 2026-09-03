import { create } from 'zustand';
import { useSessionStore } from './session-store';
import { useTaskStore } from './task-store';
import { toast } from './notification-store';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { resolveSessionWorktreeLifecycleTarget } from '@/lib/session/session-worktree-lifecycle';
import { wsClient } from '@/lib/ws/client';
import { useTabStore } from './tab-store';

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
  /** Clear multi-selection and use this normal click as the next Shift range anchor */
  setRangeAnchor: (id: string) => void;
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
  /** Stop the runtimes for all selected sessions */
  bulkStop: () => void;
  /** Delete all selected sessions */
  bulkDelete: () => Promise<void>;
  /** Open selected sessions together in a new split-view tab. */
  openInSplitView: () => void;
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

  setRangeAnchor: (id) =>
    set({ selectedIds: new Set(), lastClickedId: id, barAnchorId: null }),

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
      const session = projectViewWorkspaceState.resolveSession(id);
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

    const targets = new Map<string, {
      ids: string[];
      target: ReturnType<typeof resolveSessionWorktreeLifecycleTarget>;
    }>();
    for (const id of selectedIds) {
      const task = projectViewWorkspaceState.resolveTaskBySessionId(id);
      const target = resolveSessionWorktreeLifecycleTarget(id, task);
      const key = target.kind === 'worktree' ? `worktree:${target.taskId}` : `session:${id}`;
      const existing = targets.get(key);
      if (existing) existing.ids.push(id);
      else targets.set(key, { ids: [id], target });
    }

    const results = await Promise.all([...targets.values()].map(async ({ ids, target }) => ({
      ids,
      success: target.kind === 'worktree'
        ? await useTaskStore.getState().toggleTaskArchive(target.taskId, true)
        : await useSessionStore.getState().toggleArchive(target.sessionId, true),
    })));
    const failedIds = results.flatMap(({ ids, success }) => success ? [] : ids);
    const successCount = selectedIds.size - failedIds.length;
    if (failedIds.length > 0) {
      set({ selectedIds: new Set(failedIds), lastClickedId: null, barAnchorId: null });
      if (successCount > 0) toast.warning(`${successCount}개 아카이브 성공, ${failedIds.length}개 실패`);
      else toast.error(`아카이브 실패: ${failedIds.length}개 항목을 처리할 수 없습니다`);
      return;
    }
    set({ selectedIds: new Set(), lastClickedId: null, barAnchorId: null });
    toast.success(`${successCount}개 항목을 아카이브했습니다`);
  },

  bulkStop: () => {
    const { selectedIds } = get();
    if (selectedIds.size === 0) return;

    for (const id of selectedIds) {
      wsClient.stopSession(id);
      projectViewWorkspaceState.markSessionRead(id);
    }
    toast.success(`${selectedIds.size}개 세션에 중지 요청을 보냈습니다`);
  },

  openInSplitView: () => {
    const tabId = useTabStore.getState().createTabWithSessions([...get().selectedIds]);
    if (tabId) set({ selectedIds: new Set(), lastClickedId: null, barAnchorId: null });
  },

  bulkDelete: async () => {
    const { selectedIds } = get();
    if (selectedIds.size === 0) return;

    const ids = [...selectedIds];
    const failedIds: string[] = [];
    const targets = new Map<string, {
      ids: string[];
      target: ReturnType<typeof resolveSessionWorktreeLifecycleTarget>;
    }>();

    // A single-session Worktree is represented by its child Session in the
    // list. Several selected appearances can therefore resolve to the same
    // Worktree. Collapse those before issuing requests so one batch never
    // races itself or leaves a stale optimistic cache behind.
    for (const id of ids) {
      const task = projectViewWorkspaceState.resolveTaskBySessionId(id);
      const target = resolveSessionWorktreeLifecycleTarget(id, task);
      const key = target.kind === 'worktree' ? `worktree:${target.taskId}` : `session:${id}`;
      const existing = targets.get(key);
      if (existing) existing.ids.push(id);
      else targets.set(key, { ids: [id], target });
    }

    await Promise.all([...targets.values()].map(async ({ ids: targetIds, target }) => {
      try {
        if (target.kind === 'worktree') {
          if (!await useTaskStore.getState().deleteWorktree(target.taskId)) {
            failedIds.push(...targetIds);
          }
          return;
        }
        const res = await fetchWithClientId(`/api/sessions/${encodeURIComponent(target.sessionId)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          // A child Session is rendered from the Task cache rather than the
          // direct Project Session list. Both caches must change in the same
          // tick or the menu continues to show a successfully deleted row.
          useSessionStore.getState().removeSession(target.sessionId);
          useTaskStore.getState().removeTaskSession(target.sessionId);
        } else {
          failedIds.push(...targetIds);
        }
      } catch {
        failedIds.push(...targetIds);
      }
    }));

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
