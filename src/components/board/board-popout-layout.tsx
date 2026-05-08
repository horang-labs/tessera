'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSessionStore } from '@/stores/session-store';
import { useBoardStore } from '@/stores/board-store';
import { useWebSocket } from '@/hooks/use-websocket';
import { useCrossWindowUiSync } from '@/hooks/use-cross-window-ui-sync';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { ProjectStrip } from '@/components/chat/project-strip';
import { ElectronTitlebarThemeSync } from '@/components/layout/electron-titlebar';
import { KeyboardShortcutProvider } from '@/components/keyboard/keyboard-shortcut-provider';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { cn } from '@/lib/utils';

interface PopoutHydrationParams {
  projectDir: string | null;
  collectionFilter: string | null;
}

function readPopoutHydrationParams(): PopoutHydrationParams {
  if (typeof window === 'undefined') return { projectDir: null, collectionFilter: null };
  const params = new URLSearchParams(window.location.search);
  return {
    projectDir: params.get('projectDir'),
    collectionFilter: params.get('collectionFilter'),
  };
}

const KanbanBoard = dynamic(
  () => import('@/components/board/kanban-board').then((m) => m.KanbanBoard),
  { ssr: false },
);
const ToastContainer = dynamic(
  () => import('@/components/notifications/toast-container').then((m) => m.ToastContainer),
  { ssr: false },
);

export function BoardPopoutLayout() {
  const electronPlatform = useElectronPlatform();
  const isMacElectron = electronPlatform === 'darwin';
  const isWindowsElectron = electronPlatform === 'win32';
  const isElectronTitlebar = isMacElectron || isWindowsElectron;
  const projects = useSessionStore((s) => s.projects);
  const [projectsLoaded, setProjectsLoaded] = useState(projects.length > 0);
  const hydrationRef = useRef<PopoutHydrationParams>({ projectDir: null, collectionFilter: null });
  const hasHydratedRef = useRef(false);

  if (!hasHydratedRef.current && typeof window !== 'undefined') {
    hasHydratedRef.current = true;
    const params = readPopoutHydrationParams();
    hydrationRef.current = params;
    const boardState = useBoardStore.getState();
    if (params.projectDir) {
      boardState.setSelectedProjectDir(params.projectDir);
    }
    boardState.setCollectionFilter(params.collectionFilter ?? null);
  }

  useWebSocket();
  useCrossWindowUiSync();

  useEffect(() => {
    (window as Window & { __TESSERA_POPOUT__?: boolean }).__TESSERA_POPOUT__ = true;
    return () => {
      (window as Window & { __TESSERA_POPOUT__?: boolean }).__TESSERA_POPOUT__ = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(useSessionStore.getState().loadProjects()).finally(() => {
      if (!cancelled) setProjectsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectsLoaded) return;
    const current = useBoardStore.getState().selectedProjectDir;
    if (projects.length === 0) {
      if (current !== ALL_PROJECTS_SENTINEL) {
        useBoardStore.getState().setSelectedProjectDir(ALL_PROJECTS_SENTINEL);
      }
      return;
    }
    if (current === null) {
      const proj = projects.find((p) => p.isCurrent) ?? projects[0];
      useBoardStore.getState().setSelectedProjectDir(proj.encodedDir);
    } else if (current !== ALL_PROJECTS_SENTINEL) {
      const stillExists = projects.some((p) => p.encodedDir === current);
      if (!stillExists) {
        const proj = projects.find((p) => p.isCurrent) ?? projects[0];
        useBoardStore.getState().setSelectedProjectDir(proj.encodedDir);
      }
    }
  }, [projects, projectsLoaded]);

  return (
    <KeyboardShortcutProvider>
      <ElectronTitlebarThemeSync />
      <div className="flex h-screen flex-col overflow-hidden bg-(--board-bg)" data-testid="board-popout-layout">
        {isElectronTitlebar && (
          <div
            className={cn(
              'electron-drag shrink-0 flex items-center select-none',
              isWindowsElectron && 'h-[40px] bg-(--electron-titlebar-bg) border-b border-(--electron-titlebar-border)',
              isMacElectron && 'h-10 bg-(--chat-header-bg) border-b border-(--chat-header-border) pl-20',
            )}
            data-testid="board-popout-titlebar"
          >
            <div className="px-3 text-[0.8125rem] font-semibold text-(--text-muted) truncate">
              Tessera Board
            </div>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          <ProjectStrip
            onAddProject={() => {}}
            onRemoveProject={() => {}}
            hideManagementActions
          />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <KanbanBoard />
          </div>
        </div>
      </div>
      <ToastContainer />
    </KeyboardShortcutProvider>
  );
}
