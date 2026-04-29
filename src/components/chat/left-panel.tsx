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
import { useSessionCrud } from '@/hooks/use-session-crud';

interface LeftPanelProps {
  width: number;
}

export function LeftPanel({ width }: LeftPanelProps) {
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const viewMode = useBoardStore((state) => state.viewMode);
  const projects = useSessionStore((state) => state.projects);
  const { deleteProject } = useSessionCrud();

  const handleAddProject = () => setShowFolderBrowser(true);

  const handleFolderSelect = useCallback(async (folderPath: string) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    await useSessionStore.getState().loadProjects();
    if (res.ok) {
      const { projectId } = await res.json() as { projectId: string };
      useBoardStore.getState().setSelectedProjectDir(projectId);
      useTabStore.getState().switchProject(projectId);
    }
  }, []);

  return (
    <div
      className="shrink-0 flex flex-col border-r border-(--divider) overflow-hidden"
      style={{ width: `${width}px` }}
      data-testid="left-panel-container"
    >
      <AppHeader />
      <div className="flex-1 flex overflow-hidden min-h-0">
        <ProjectStrip onAddProject={handleAddProject} onRemoveProject={setRemoveTarget} />
        <div className="flex-1 overflow-hidden min-w-0">
          {viewMode === 'board' ? <KanbanBoard /> : <Sidebar />}
        </div>
      </div>
      <FolderBrowserDialog
        isOpen={showFolderBrowser}
        onClose={() => setShowFolderBrowser(false)}
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
