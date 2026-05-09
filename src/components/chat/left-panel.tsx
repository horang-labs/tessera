'use client';

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { AppHeader } from '@/components/layout/app-header';
import { ProjectStrip } from './project-strip';
import { Sidebar } from './sidebar';
const KanbanBoard = dynamic(
  () => import('@/components/board/kanban-board').then((m) => m.KanbanBoard),
  { ssr: false },
);
import { FolderBrowserDialog } from './folder-browser-dialog';
import { DeleteProjectDialog } from './delete-project-dialog';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { useTabStore } from '@/stores/tab-store';
import { useFolderBrowserStore } from '@/stores/folder-browser-store';
import { useSessionCrud } from '@/hooks/use-session-crud';
import { usePopoutActive } from '@/hooks/use-popout-active';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LeftPanelProps {
  width: number | string;
  className?: string;
}

export function LeftPanel({ width, className }: LeftPanelProps) {
  const isFolderBrowserOpen = useFolderBrowserStore((state) => state.isOpen);
  const openFolderBrowser = useFolderBrowserStore((state) => state.open);
  const closeFolderBrowser = useFolderBrowserStore((state) => state.close);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const viewMode = useBoardStore((state) => state.viewMode);
  const projects = useSessionStore((state) => state.projects);
  const { deleteProject } = useSessionCrud();
  const { isActive: isPopoutActive, closePopouts } = usePopoutActive();

  const handleAddProject = openFolderBrowser;

  const handleFolderSelect = useCallback(async (folderPath: string) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error || 'Failed to add project');
    }

    await useSessionStore.getState().loadProjects();
    const { projectId } = await res.json() as { projectId: string };
    useBoardStore.getState().setSelectedProjectDir(projectId);
    useTabStore.getState().switchProject(projectId);
  }, []);

  return (
    <div
      className={cn("shrink-0 flex border-r border-(--divider) overflow-hidden", className)}
      style={{ width: typeof width === 'number' ? `${width}px` : width }}
      data-testid="left-panel-container"
    >
      <ProjectStrip onAddProject={handleAddProject} onRemoveProject={setRemoveTarget} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <div className="min-h-0 flex-1 overflow-hidden relative">
          {viewMode === 'board' ? <KanbanBoard /> : <Sidebar />}
          {viewMode === 'board' && isPopoutActive && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-(--board-bg)/80 backdrop-blur-sm"
              data-testid="board-popout-lock"
            >
              <div className="flex flex-col items-center gap-3 px-6 py-5 max-w-sm text-center rounded-lg border border-(--divider) bg-(--sidebar-bg) shadow-lg">
                <ExternalLink className="w-6 h-6 text-(--text-muted)" />
                <div className="text-[0.875rem] font-semibold text-(--text-primary)">
                  Board open in another window
                </div>
                <div className="text-[0.8125rem] text-(--text-muted)">
                  The board view is currently popped out. Close the pop-out window to use it here.
                </div>
                <button
                  type="button"
                  onClick={() => { void closePopouts(); }}
                  className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-(--accent) text-white text-[0.8125rem] font-medium cursor-pointer hover:opacity-90 transition-opacity"
                  data-testid="board-popout-close-btn"
                >
                  Close pop-out window
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <FolderBrowserDialog
        isOpen={isFolderBrowserOpen}
        onClose={closeFolderBrowser}
        onSelect={handleFolderSelect}
      />
      <DeleteProjectDialog
        project={removeTarget ? projects.find((p) => p.encodedDir === removeTarget) ?? null : null}
        isOpen={removeTarget !== null}
        onConfirm={async () => {
          if (removeTarget) await deleteProject(removeTarget);
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
