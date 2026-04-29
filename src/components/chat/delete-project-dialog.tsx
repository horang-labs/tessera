'use client';

import { EyeOff, Info } from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { useI18n } from '@/lib/i18n';
import type { ProjectGroup } from '@/types/chat';

interface DeleteProjectDialogProps {
  project: ProjectGroup | null;
  isOpen: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Remove Project Confirmation Dialog
 *
 * Hides a project from the sidebar. Session files are preserved.
 */
export function DeleteProjectDialog({
  project,
  isOpen,
  onConfirm,
  onCancel,
}: DeleteProjectDialogProps) {
  const { t } = useI18n();

  if (!project) return null;

  return (
    <AsyncConfirmDialog
      open={isOpen}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={t('dialog.removeProjectTitle')}
      icon={EyeOff}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('dialog.remove')}
      confirmingLabel={t('dialog.removing')}
      dialogTestId="delete-project-dialog"
      cancelTestId="delete-project-cancel"
      confirmTestId="delete-project-confirm"
      errorLogLabel="Remove project error:"
      description={(
        <div className="space-y-3">
          <p className="text-(--text-primary)">
            {t('dialog.removeProjectConfirm', { name: project.displayName })}
          </p>

          <div className="bg-(--accent)/8 border border-(--accent)/20 rounded-md px-3 py-2 flex items-start gap-2">
            <Info className="w-4 h-4 text-(--accent) shrink-0 mt-0.5" />
            <p className="text-xs text-(--text-muted)">
              {t('dialog.removeProjectNote')}
            </p>
          </div>
        </div>
      )}
    />
  );
}
