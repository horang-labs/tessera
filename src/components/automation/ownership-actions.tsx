'use client';

import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import type { InputOwnership } from '@/lib/automation/contracts';
import { useI18n } from '@/lib/i18n';
import { buttonVariants } from '@/components/ui/button';

export const automationButton = `${buttonVariants({ variant: 'outline', size: 'sm' })} min-h-9 max-sm:min-h-11 h-auto`;

export const automationPrimaryButton = `${buttonVariants({ size: 'sm' })} min-h-9 max-sm:min-h-11 h-auto`;

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
      <button {...telemetryClickAttributes('automation.pause', 'chat_header')} type="button" className={automationButton} onClick={onPause}>{t('automation.pause')}</button>
      <button {...telemetryClickAttributes('automation.delete', 'chat_header')} type="button" className={automationButton} onClick={onDelete}>{t('automation.delete')}</button>
    </>}
  </>;
}
