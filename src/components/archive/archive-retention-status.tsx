'use client';

import { Loader2 } from 'lucide-react';
import { useArchiveRetentionProgress, isArchiveRetentionActive } from '@/hooks/use-archive-retention-progress';
import { useI18n } from '@/lib/i18n';

export function ArchiveRetentionStatus() {
  const { t } = useI18n();
  const progress = useArchiveRetentionProgress();
  if (!progress || progress.phase === 'idle' || (progress.phase === 'complete' && progress.total === 0 && progress.errors.length === 0)) return null;
  const active = isArchiveRetentionActive(progress);
  const label = progress.phase === 'scanning'
    ? t('archive.retentionProgress.scanning')
    : active
      ? t('archive.retentionProgress.running', { completed: progress.completed, total: progress.total })
      : t('archive.retentionProgress.complete');

  return (
    <section className="rounded-lg border border-(--divider) bg-(--board-card-bg) px-3 py-2 text-xs" data-testid="archive-retention-status">
      <div role="status" className="flex items-center gap-2 text-(--text-primary)">
        {active && <span className="shrink-0 motion-safe:animate-spin"><Loader2 className="h-3.5 w-3.5 text-(--accent)" aria-hidden="true" /></span>}
        <span>{label}</span>
        {progress.phase === 'waiting' && <span className="text-(--text-muted)">{t('archive.retentionProgress.waiting')}</span>}
      </div>
      {active && progress.total > 0 && (
        <progress className="mt-2 h-1.5 w-full accent-(--accent)" max={progress.total} value={progress.completed} aria-label={label} />
      )}
      {progress.currentTitle && <p className="mt-1 truncate text-(--text-muted)" title={progress.currentTitle}>{progress.currentTitle}</p>}
      {progress.phase !== 'scanning' && (
        <p className="mt-1 text-(--text-muted)">
          {t('archive.retentionProgress.summary', { removed: progress.removed, skipped: progress.skipped, failed: progress.errors.length })}
        </p>
      )}
      {progress.errors.length > 0 && (
        <details className="mt-2 text-(--error)">
          <summary className="cursor-pointer">{t('archive.retentionProgress.failures', { count: progress.errors.length })}</summary>
          <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto break-words">
            {progress.errors.map((failure, index) => (
              <li key={`${failure.kind}:${failure.id}:${index}`}>{failure.title ?? failure.id}: {failure.error}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
