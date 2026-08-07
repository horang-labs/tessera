'use client';

import { useMemo } from 'react';
import { useCollectionStore } from '@/stores/collection-store';
import { useSessionStore } from '@/stores/session-store';
import type { Collection } from '@/types/collection';
import type { TaskEntity } from '@/types/task-entity';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';

/** Where the branch was requested from: which task, and where the menu opened. */
export interface BranchFromWorktreeSource {
  task: TaskEntity;
  point: { x: number; y: number };
}

const EMPTY_COLLECTIONS: Collection[] = [];

/**
 * The creation sheet, opened from a worktree so the new one starts at that
 * worktree's branch. Everything else about the sheet stays as it is elsewhere —
 * only the base ref is decided in advance, and it cannot be changed here.
 */
export function BranchFromWorktreeSheet({
  source,
  onClose,
}: {
  source: BranchFromWorktreeSource | null;
  onClose: () => void;
}) {
  const projects = useSessionStore((state) => state.projects);
  const task = source?.task ?? null;

  // Task rows disagree on whether projectId holds the encoded or decoded form,
  // so match on either rather than trusting one.
  const project = useMemo(() => {
    if (!task) return null;
    return projects.find(
      (entry) => entry.encodedDir === task.projectId || entry.decodedPath === task.projectId,
    ) ?? null;
  }, [projects, task]);

  const collections = useCollectionStore((state) =>
    project ? state.collectionsByProject?.[project.encodedDir] ?? EMPTY_COLLECTIONS : EMPTY_COLLECTIONS,
  );

  const collection = useMemo(
    () => collections.find((item) => item.id === task?.collectionId) ?? null,
    [collections, task?.collectionId],
  );

  if (!source || !task?.worktreeBranch || !project) return null;

  return (
    <CollectionQuickCreateSheet
      collection={collection}
      collections={collections}
      projectDir={project.decodedPath}
      projectId={project.encodedDir}
      // A chat session has no worktree, so branching from one is meaningless.
      availableModes={['task']}
      allowCollectionSelection
      anchorPoint={source.point}
      scopeId={`branch-${task.id}`}
      fixedBaseRef={task.worktreeBranch}
      uncommittedChangeCount={task.diffStats?.changedFiles ?? 0}
      onClose={onClose}
    />
  );
}

/** Whether a task can be branched from — its branch outlives its worktree. */
export function canBranchFromTask(task: Pick<TaskEntity, 'worktreeBranch'> | null | undefined): boolean {
  return Boolean(task?.worktreeBranch);
}
