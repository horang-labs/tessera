'use client';

import { memo, useCallback } from 'react';
import { useBoardStore } from '@/stores/board-store';
import { saveCurrentKanbanScrollPosition } from '@/lib/kanban-scroll-position';
import { cn } from '@/lib/utils';
import { ViewModeToggle } from './view-mode-toggle';
import type { ViewMode } from '@/stores/board-store';

interface ProjectViewModeToggleProps {
  className?: string;
  labelMode?: 'full' | 'short' | 'icon';
}

export const ProjectViewModeToggle = memo(function ProjectViewModeToggle({
  className,
  labelMode = 'short',
}: ProjectViewModeToggleProps) {
  const viewMode = useBoardStore((state) => state.viewMode);
  const setViewMode = useBoardStore((state) => state.setViewMode);
  const selectedProjectDir = useBoardStore((state) => state.selectedProjectDir);
  const activeCollectionFilter = useBoardStore((state) => state.activeCollectionFilter);

  const handleViewModeChange = useCallback(
    (nextMode: ViewMode) => {
      if (viewMode === 'board') {
        saveCurrentKanbanScrollPosition(selectedProjectDir, activeCollectionFilter);
      }
      setViewMode(nextMode);
    },
    [activeCollectionFilter, selectedProjectDir, setViewMode, viewMode],
  );

  if (!selectedProjectDir) return null;

  return (
    <div
      className={cn('flex shrink-0 items-center', className)}
      data-testid="project-view-mode-control"
    >
      <ViewModeToggle
        viewMode={viewMode}
        onToggle={handleViewModeChange}
        labelMode={labelMode}
      />
    </div>
  );
});
