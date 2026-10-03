'use client';

import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import type { InputOwnership } from '@/lib/automation/contracts';
import { useI18n } from '@/lib/i18n';
import { buttonVariants } from '@/components/ui/button';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';

export const automationButton = `${buttonVariants({ variant: 'outline', size: 'sm' })} min-h-9 max-sm:min-h-11 h-auto`;

export const automationToolbarButton = `inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded px-1 text-[10px] leading-none whitespace-nowrap text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary) focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-(--accent) ${PHONE_TOUCH_TARGET}`;

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
