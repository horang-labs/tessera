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

interface LeftPanelProps {
  width: number;
}

export function LeftPanel({ width }: LeftPanelProps) {
  const isFolderBrowserOpen = useFolderBrowserStore((state) => state.isOpen);
  const openFolderBrowser = useFolderBrowserStore((state) => state.open);
  const closeFolderBrowser = useFolderBrowserStore((state) => state.close);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const viewMode = useBoardStore((state) => state.viewMode);
  const projects = useSessionStore((state) => state.projects);
  const { deleteProject } = useSessionCrud();

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
      className="shrink-0 flex border-r border-(--divider) overflow-hidden"
      style={{ width: `${width}px` }}
      data-testid="left-panel-container"
    >
      <ProjectStrip onAddProject={handleAddProject} onRemoveProject={setRemoveTarget} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <div className="min-h-0 flex-1 overflow-hidden">
          {viewMode === 'board' ? <KanbanBoard /> : <Sidebar />}
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
