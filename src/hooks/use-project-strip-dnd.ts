'use client';

import { useCallback } from 'react';
import type React from 'react';
import { useBoardStore } from '@/stores/board-store';
import { useSessionStore } from '@/stores/session-store';
import { PROJECT_DND_MIME } from '@/lib/constants/project-strip';

/**
 * useProjectStripDnd
 *
 * Encapsulates HTML5 Drag & Drop logic for reordering project icons
 * in the ProjectStrip. Follows the same pattern as useColumnDnd.
 */

export interface UseProjectStripDndReturn {
  draggingProjectDir: string | null;
  projectDragOverIndex: number | null;
  handleProjectDragStart: (encodedDir: string, e: React.DragEvent) => void;
  handleProjectDragEnd: (e: React.DragEvent) => void;
  handleProjectDragOver: (index: number, e: React.DragEvent) => void;
  handleProjectDragLeave: (index: number, e: React.DragEvent) => void;
  handleProjectDrop: (targetIndex: number, e: React.DragEvent) => void;
}

export function useProjectStripDnd(): UseProjectStripDndReturn {
  const draggingProjectDir = useBoardStore((s) => s.draggingProjectDir);
  const projectDragOverIndex = useBoardStore((s) => s.projectDragOverIndex);

  const handleProjectDragStart = useCallback((encodedDir: string, e: React.DragEvent) => {
    e.dataTransfer.setData(PROJECT_DND_MIME, encodedDir);
    e.dataTransfer.effectAllowed = 'move';
    useBoardStore.getState().setDraggingProject(encodedDir);
  }, []);

  const handleProjectDragEnd = useCallback((_e: React.DragEvent) => {
    useBoardStore.getState().setDraggingProject(null);
    useBoardStore.getState().setProjectDragOverIndex(null);
  }, []);

  const handleProjectDragOver = useCallback((index: number, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PROJECT_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const current = useBoardStore.getState().projectDragOverIndex;
    if (current !== index) {
      useBoardStore.getState().setProjectDragOverIndex(index);
    }
  }, []);

  const handleProjectDragLeave = useCallback((index: number, e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    const current = useBoardStore.getState().projectDragOverIndex;
    if (current === index) {
      useBoardStore.getState().setProjectDragOverIndex(null);
    }
  }, []);

  const handleProjectDrop = useCallback((targetIndex: number, e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes(PROJECT_DND_MIME)) return;

    const draggedDir = e.dataTransfer.getData(PROJECT_DND_MIME);
    if (!draggedDir) return;

    const projects = useSessionStore.getState().projects;
    const fromIndex = projects.findIndex((p) => p.encodedDir === draggedDir);
    if (fromIndex === -1 || fromIndex === targetIndex) {
      useBoardStore.getState().setDraggingProject(null);
      useBoardStore.getState().setProjectDragOverIndex(null);
      return;
    }

    useSessionStore.getState().reorderProjects(fromIndex, targetIndex);
    useBoardStore.getState().setDraggingProject(null);
    useBoardStore.getState().setProjectDragOverIndex(null);
  }, []);

  return {
    draggingProjectDir,
    projectDragOverIndex,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragOver,
    handleProjectDragLeave,
    handleProjectDrop,
  };
}
