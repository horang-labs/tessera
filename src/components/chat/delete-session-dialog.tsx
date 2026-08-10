'use client';

import { AlertCircle } from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { useI18n } from '@/lib/i18n';
import type { UnifiedSession } from '@/types/chat';

interface DeleteSessionDialogProps {
  session: UnifiedSession | null;
  isOpen: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Delete Session Confirmation Dialog
 *
 * BR-DEL-002: 모든 삭제는 확인 다이얼로그 필수
 */
export function DeleteSessionDialog({
  session,
  isOpen,
  onConfirm,
  onCancel,
}: DeleteSessionDialogProps) {
  const { t } = useI18n();

  if (!session) return null;

  return (
    <AsyncConfirmDialog
      open={isOpen}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={t('dialog.deleteSessionTitle')}
      icon={AlertCircle}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('dialog.deleteSession')}
      confirmingLabel={t('dialog.deleting')}
      iconContainerClassName="bg-(--error)/10"
      iconClassName="text-(--error)"
      confirmButtonClassName="bg-(--error) text-white hover:bg-(--error)/90"
      dialogTestId="delete-session-dialog"
      cancelTestId="delete-session-cancel"
      confirmTestId="delete-session-confirm"
      errorLogLabel="Delete session error:"
      description={(
        <>
          <p className="text-(--text-primary)">
            {t('dialog.deleteSessionConfirm', { title: session.title })}
          </p>
          <p className="text-(--text-muted) text-sm mt-2">
            {t('dialog.deleteWarning')}
          </p>
        </>
      )}
    />
  );
}
