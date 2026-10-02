'use client';

import type { InputOwnership } from '@/lib/automation/contracts';
import { useI18n } from '@/lib/i18n';

export const automationButton = 'min-h-9 max-sm:min-h-11 rounded border border-(--divider) px-3 py-1 text-xs hover:bg-(--sidebar-hover) focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-50';

export function OwnershipActions({ ownership, automationId, onPause, onDelete }: {
  ownership: Readonly<InputOwnership>;
  automationId: string | null;
  onPause: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return <>
    <span role="status" className="text-xs" data-ownership={ownership.mode}>
      {t(`automation.${ownership.mode}`)}{ownership.reason && ` · ${ownership.reason}`}
    </span>
    {automationId && <>
      <button type="button" className={automationButton} onClick={onPause}>{t('automation.pause')}</button>
      <button type="button" className={automationButton} onClick={onDelete}>{t('automation.delete')}</button>
    </>}
  </>;
}
