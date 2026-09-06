'use client';

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/select';
import { useTaskStore } from '@/stores/task-store';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { crossEnvironmentFilesystemPathKey } from '@/lib/filesystem/path-equivalence';
import type { TaskEntity } from '@/types/task-entity';

const EMPTY_WORKTREES: TaskEntity[] = [];
type LocationKind = 'project' | 'worktree';

export function getAvailableSessionWorktrees(tasks: readonly TaskEntity[], projectDir: string): TaskEntity[] {
  const seenPaths = new Set([crossEnvironmentFilesystemPathKey(projectDir)]);
  const seenIds = new Set<string>();
  return tasks.filter((task) => {
    if (!task.workDir || (!task.worktreeId && !task.worktreeBranch) || task.archived || task.worktreeDeletedAt || task.worktreeMissing || task.isPending) return false;
    const key = crossEnvironmentFilesystemPathKey(task.workDir);
    if (seenPaths.has(key) || (task.worktreeId && seenIds.has(task.worktreeId))) return false;
    seenPaths.add(key);
    if (task.worktreeId) seenIds.add(task.worktreeId);
    return true;
  });
}

export function useSessionLocation(projectId: string | null, projectDir: string) {
  const tasks = useTaskStore((state) => projectId ? state.tasksByProject[projectId] ?? EMPTY_WORKTREES : EMPTY_WORKTREES);
  const loading = useTaskStore((state) => projectId ? Boolean(state.loadingProjectIds[projectId]) : false);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const [selection, setSelection] = useState<{ projectId: string | null; kind: LocationKind; id: string | null }>({ projectId, kind: 'project', id: null });
  if (selection.projectId !== projectId) {
    setSelection({ projectId, kind: 'project', id: null });
  }
  const locationKind = selection.projectId === projectId ? selection.kind : 'project';
  const worktrees = getAvailableSessionWorktrees(tasks, projectDir);
  const selectedWorktree = locationKind === 'worktree' ? worktrees.find((task) => task.id === selection.id) ?? null : null;
  useEffect(() => {
    if (projectId) void loadTasks(projectId, { setCurrent: false });
  }, [projectId, loadTasks]);
  return {
    worktrees, selectedWorktree, locationKind, projectDir, loading,
    setLocationKind: (kind: LocationKind) => setSelection({ projectId, kind, id: null }),
    setSelectedWorktreeId: (id: string) => setSelection({ projectId, kind: 'worktree', id }),
    canSubmit: Boolean(projectId && (locationKind === 'project' || selectedWorktree)),
  };
}

export function SessionLocationSelector({ location, disabled = false, showPath = true }: {
  location: ReturnType<typeof useSessionLocation>;
  disabled?: boolean;
  showPath?: boolean;
}) {
  const { t } = useI18n();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2" data-testid="session-location-selector" data-session-location-selector>
      <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">{t('task.creation.sessionLocationLabel')}</legend>
      <div className="flex gap-1 rounded-lg bg-(--input-bg) p-1">
        {(['project', 'worktree'] as const).map((kind) => (
          <button key={kind} type="button" aria-pressed={location.locationKind === kind} onClick={() => { location.setLocationKind(kind); }} className={cn('flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors disabled:opacity-50', location.locationKind === kind ? 'border-(--accent) bg-(--sidebar-hover) text-(--sidebar-text-active)' : 'border-transparent text-(--text-muted)')}>
            {kind === 'project' ? t('task.creation.projectFolder') : t('task.creation.existingWorktrees', { count: location.worktrees.length })}
          </button>
        ))}
      </div>
      {location.locationKind === 'worktree' && (
        <div className="space-y-2">
          {location.loading && location.worktrees.length === 0 ? <p className="text-xs text-(--text-muted)">{t('common.loading')}</p> : location.worktrees.length === 0 ? <p className="text-xs text-(--text-muted)">{t('task.creation.noExistingWorktrees')}</p> : (
            <Select
              value={location.selectedWorktree?.id ?? ''}
              onValueChange={location.setSelectedWorktreeId}
              disabled={disabled}
              placeholder={t('task.creation.chooseWorktree')}
              aria-label={t('task.creation.chooseWorktree')}
              searchPlaceholder={t('task.creation.searchWorktrees')}
              emptyLabel={t('task.creation.noMatchingWorktrees')}
              options={location.worktrees.map((task) => ({ value: task.id, label: task.title, description: task.worktreeBranch }))}
              className="text-xs"
            />
          )}
        </div>
      )}
      {showPath && (location.locationKind === 'project' || location.selectedWorktree) && <p className="break-all text-[11px] text-(--text-muted)">{location.selectedWorktree?.workDir ?? location.projectDir}</p>}
    </fieldset>
  );
}
