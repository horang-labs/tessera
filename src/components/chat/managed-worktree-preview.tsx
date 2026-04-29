'use client';

import { FolderGit2 } from 'lucide-react';
import { buildManagedWorktreeNamePreview, buildManagedWorktreePreviewPath } from '@/lib/worktrees/naming';
import { useSettingsStore } from '@/stores/settings-store';

interface ManagedWorktreePreviewProps {
  projectDir: string | null;
  branchLabel: string;
  pathHint?: string;
  branchTestId: string;
  pathTestId: string;
  error?: string | null;
  errorTestId?: string;
}

export function ManagedWorktreePreview({
  projectDir,
  branchLabel,
  pathHint,
  branchTestId,
  pathTestId,
  error,
  errorTestId,
}: ManagedWorktreePreviewProps) {
  const branchPrefix = useSettingsStore((state) => state.settings.gitConfig.branchPrefix);
  const branchPreview = buildManagedWorktreeNamePreview(projectDir, branchPrefix);
  const pathPreview = buildManagedWorktreePreviewPath(projectDir, branchPrefix);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-(--text-muted)">
          {branchLabel}
        </p>
        <div
          className="flex items-center gap-2 rounded-md border border-(--divider) bg-(--sidebar-hover) px-3 py-2"
          data-testid={branchTestId}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
          <span className="flex-1 text-sm font-mono text-(--sidebar-text-active)">
            {branchPreview}
          </span>
        </div>
        {error && errorTestId ? (
          <p
            id={errorTestId}
            className="text-xs text-[color:var(--error)]"
            role="alert"
            data-testid={errorTestId}
          >
            {error}
          </p>
        ) : null}
      </div>

      {pathHint ? (
        <p className="text-[11px] text-(--text-muted)">
          {pathHint}
        </p>
      ) : null}

      <p className="truncate font-mono text-[11px] text-(--text-muted)" data-testid={pathTestId}>
        <span className="mr-1 text-(--accent)">&rarr;</span>
        {pathPreview}
      </p>
    </div>
  );
}
