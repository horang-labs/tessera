'use client';

import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { useTaskStore } from '@/stores/task-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useBoardStore } from '@/stores/board-store';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';

interface PopoutElectronApi {
  isElectron?: boolean;
  getPopoutState?: () => Promise<{ count?: number }>;
  onPopoutStateChanged?: (cb: (count: number) => void) => (() => void) | void;
  closeBoardPopouts?: () => Promise<unknown>;
}

function getApi(): PopoutElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: PopoutElectronApi }).electronAPI;
}

export async function reloadBoardData(): Promise<void> {
  await useSessionStore.getState().loadProjects();

  const selectedProjectDir = useBoardStore.getState().selectedProjectDir;
  const projects = projectViewWorkspaceState.getLoadedProjectViews();

  const targetProjectIds =
    selectedProjectDir === ALL_PROJECTS_SENTINEL || selectedProjectDir === null
      ? projects.map((p) => p.encodedDir)
      : [selectedProjectDir];

  await Promise.all(
    targetProjectIds.flatMap((projectId) => [
      useTaskStore.getState().loadTasks(projectId),
      useCollectionStore.getState().loadCollections(projectId, { force: true }),
    ]),
  );
}

export function usePopoutActive(): {
  isActive: boolean;
  closePopouts: () => Promise<void>;
} {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const api = getApi();
    if (!api?.isElectron) return;

    let cancelled = false;
    void api.getPopoutState?.().then((state) => {
      if (!cancelled && typeof state?.count === 'number') {
        setCount(state.count);
      }
    });

    const cleanup = api.onPopoutStateChanged?.((next) => setCount(next));
    return () => {
      cancelled = true;
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  return {
    isActive: count > 0,
    closePopouts: async () => {
      await getApi()?.closeBoardPopouts?.();
    },
  };
}
