'use client';

import { X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { WorktreeOverview } from '@/components/worktree/worktree-overview';
import { useLoadedProjectViews } from '@/hooks/use-project-view-workspace-state';
import { useTaskStore } from '@/stores/task-store';
import { useWorkspacePeekStore } from '@/stores/workspace-peek-store';

export function WorktreePeek() {
  const target = useWorkspacePeekStore((state) => state.target);
  const close = useWorkspacePeekStore((state) => state.close);
  const projects = useLoadedProjectViews();
  const project = target
    ? projects.find((candidate) =>
      candidate.encodedDir === target.projectDir
      && candidate.projectWorktree?.id === target.worktreeId
    ) ?? null
    : null;
  const linkedWorktree = useTaskStore((state) => {
    if (!target) return null;
    return state.tasksByProject[target.projectDir]?.find(
      (candidate) => candidate.worktreeId === target.worktreeId,
    ) ?? null;
  });
  const backdropPointerStartedRef = useRef(false);

  useEffect(function closeWorktreePeekOnEscape() {
    if (!target) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [close, target]);

  const handleBackdropPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    backdropPointerStartedRef.current = event.target === event.currentTarget;
  }, []);

  const handleBackdropPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const shouldClose = backdropPointerStartedRef.current && event.target === event.currentTarget;
    backdropPointerStartedRef.current = false;
    if (shouldClose) close();
  }, [close]);

  if (!target) return null;

  const isProjectWorktree = Boolean(project?.projectWorktree);
  const branch = project?.projectWorktree?.currentBranch
    ?? linkedWorktree?.worktreeBranch
    ?? null;
  const displayPath = project?.projectWorktree?.displayPath
    ?? linkedWorktree?.workDir
    ?? '';
  const label = isProjectWorktree
    ? project?.displayName ?? 'Project Worktree'
    : linkedWorktree?.title ?? 'Linked Worktree';

  return (
    <section
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/35 p-3 backdrop-blur-[2px] sm:p-5"
      data-testid="worktree-peek-backdrop"
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onPointerCancel={() => { backdropPointerStartedRef.current = false; }}
    >
      <div
        role="dialog"
        aria-label={`${label} preview`}
        className="flex h-[min(82%,36rem)] w-[min(94%,52rem)] min-h-72 flex-col overflow-hidden rounded-xl border border-(--divider) bg-(--chat-bg) shadow-[0_28px_90px_rgba(0,0,0,0.46)]"
        data-testid="worktree-peek"
        data-worktree-id={target.worktreeId}
      >
        <header className="flex h-11 shrink-0 items-center border-b border-(--divider) bg-(--chat-header-bg) px-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-(--text-muted)">
            Worktree preview
          </span>
          <button
            type="button"
            onClick={close}
            className="flex h-11 w-11 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
            aria-label="Close Worktree preview"
            data-testid="worktree-peek-close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <WorktreeOverview
            branch={branch}
            displayPath={displayPath || 'Unknown path'}
            label={label}
          />
        </div>
      </div>
    </section>
  );
}
