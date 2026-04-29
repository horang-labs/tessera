'use client';

import { AlertCircle } from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { useI18n } from '@/lib/i18n';
import type { TaskEntity } from '@/types/task-entity';

interface DeleteTaskDialogProps {
  task: TaskEntity | null;
  isOpen: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function DeleteTaskDialog({
  task,
  isOpen,
  onConfirm,
  onCancel,
}: DeleteTaskDialogProps) {
  const { t } = useI18n();

  if (!task) return null;

  const sessionCount = task.sessions.length;

  return (
    <AsyncConfirmDialog
      open={isOpen}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={t('dialog.deleteTaskTitle')}
      icon={AlertCircle}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('dialog.deleteTask')}
      iconContainerClassName="bg-(--error)/10"
      iconClassName="text-(--error)"
      confirmButtonClassName="bg-(--error) text-white hover:bg-(--error)/90"
      dialogTestId="delete-task-dialog"
      confirmTestId="delete-task-confirm"
      description={(
        <>
          <p className="text-(--text-primary)">
            {t('dialog.deleteTaskConfirm', { title: task.title })}
          </p>
          {sessionCount > 0 && (
            <p className="mt-2 text-sm text-(--text-muted)">
              {t('dialog.deleteTaskChildSessions', { count: sessionCount })}
            </p>
          )}
          <p className="mt-2 text-sm text-(--text-muted)">
            {t('dialog.deleteWarning')}
          </p>
        </>
      )}
    />
  );
}
