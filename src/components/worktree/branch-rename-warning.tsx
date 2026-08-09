import { AlertTriangle, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { ProjectBranchRenameWarning } from '@/lib/projects/branch-rename-warning';

export function BranchRenameWarning({
  warning,
  onDismiss,
}: {
  warning: ProjectBranchRenameWarning;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <aside
      role="status"
      className="mb-2 flex gap-2 rounded-md border border-(--status-warning-border) bg-(--status-warning-bg) px-2 py-2 text-(--status-warning-text)"
      data-testid="branch-rename-warning"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[0.6875rem] font-semibold leading-4">
          {t('sidebar.branchRenameWarningTitle')}
        </p>
        <p className="mt-0.5 text-[0.6875rem] leading-4 text-(--text-secondary)">
          {t('sidebar.branchRenameWarningDescription', {
            previousBranch: warning.previousBranch,
            currentBranch: warning.currentBranch,
          })}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-(--text-muted) transition-colors hover:bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] hover:text-(--text-primary) focus-visible:bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] focus-visible:text-(--text-primary)"
        aria-label={t('sidebar.dismissBranchRenameWarning')}
        title={t('sidebar.dismissBranchRenameWarning')}
        data-testid="branch-rename-warning-dismiss"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </aside>
  );
}
