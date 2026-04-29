'use client';

import { useI18n } from '@/lib/i18n';

export interface ShortcutConflictDialogProps {
  existingActionLabel: string;
  formattedKey: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ShortcutConflictDialog({
  existingActionLabel,
  formattedKey,
  onConfirm,
  onCancel,
}: ShortcutConflictDialogProps) {
  const { t } = useI18n();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div role="dialog" aria-modal="true" className="bg-(--sidebar-bg) border border-(--input-border) rounded-lg p-4 max-w-sm">
        <p className="text-sm text-(--text-primary) mb-3">
          {t('settings.shortcutConflict.message', { key: formattedKey, action: existingActionLabel })}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-sm rounded border border-(--input-border) text-(--text-secondary)"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1 text-sm rounded bg-(--accent) text-white hover:bg-(--accent-hover)"
          >
            {t('settings.shortcutConflict.overwrite')}
          </button>
        </div>
      </div>
    </div>
  );
}
