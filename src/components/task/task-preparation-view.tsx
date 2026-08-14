'use client';

/**
 * The preparation badge on a task row.
 *
 * It says something is happening, or that something went wrong; what it does
 * is send the reader to the worktree's Scripts tab, where the run — live or
 * finished — actually lives. The badge deliberately owns no view of its own:
 * a successful run has no badge, and a run that can only be reached through
 * one is a run nobody can look at afterwards.
 */

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useGitStore } from '@/stores/git-store';
import {
  resolvePreparationBadge,
  type PreparationStatus,
} from '@/lib/projects/preparation-status-policy';

/**
 * `presentation` is how much of the badge a surface has room for. A dense list
 * row only has space for the icon; a card can carry the words too.
 */
export function TaskPreparationBadge({
  status,
  presentation = 'label',
}: {
  status: PreparationStatus | undefined;
  presentation?: 'label' | 'icon';
}) {
  const { t } = useI18n();
  const openTab = useGitStore((state) => state.openTab);

  const badge = resolvePreparationBadge(status ?? 'never_run');
  if (!badge) return null;

  const isRunning = badge === 'running';
  const label = isRunning ? t('task.preparation.preparing') : t('task.preparation.failed');
  const icon = isRunning
    ? <Loader2 className="h-3 w-3 animate-spin" />
    : <AlertTriangle className="h-3 w-3" />;
  const tone = isRunning
    ? 'inline-flex items-center gap-1 text-[0.6875rem] text-(--text-muted)'
    : 'inline-flex items-center gap-1 text-[0.6875rem] text-(--error)';

  return (
    <button
      {...telemetryClickAttributes('task.preparation.open', 'workspace_list')}
      type="button"
      onClick={() => {
        // The click is left to bubble on purpose: the row it sits in opens the
        // session, and the panel then shows that worktree's scripts rather
        // than whichever worktree happened to be open before.
        openTab('scripts');
      }}
      title={label}
      aria-label={label}
      className={`${tone} ${isRunning ? 'hover:text-(--text-primary)' : 'hover:opacity-80'}`}
      data-testid="task-preparation-badge"
      data-preparation-status={status}
    >
      {icon}
      {presentation === 'label' ? <span>{label}</span> : null}
    </button>
  );
}
