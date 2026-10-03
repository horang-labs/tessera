'use client';

import type { AutorunPreview } from '@/lib/automation/autorun-contracts';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { automationButton } from './ownership-actions';

export function AutomationPreflight({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) {
  const { t } = useI18n();
  if (loading) return <div role="status" aria-live="polite" aria-busy="true" className="flex items-start gap-2 text-sm">
    <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-(--accent)" aria-hidden="true" />
    <div><p className="font-medium">{t('automation.checkingSetup')}</p><p className="mt-1 text-xs leading-relaxed text-(--text-secondary)">{t('automation.checkingHint')}</p></div>
  </div>;
  if (error) return <div className="grid justify-items-start gap-2"><p role="alert" className="text-sm text-(--status-error-text)">{t(error === 'PREVIEW_TIMEOUT' ? 'automation.previewTimeout' : 'automation.previewFailed')}</p>
    <button {...telemetryClickAttributes('automation.autorun.refresh', 'automation')} type="button" className={automationButton} onClick={onRetry}>{t('automation.checkAgain')}</button>
  </div>;
  return null;
}


export function AutomationReadinessRecovery({ preview, onOpenSession }: {
  method?: 'autorun' | 'heartbeat'; preview: AutorunPreview | null; resume?: boolean; onOpenSession: () => void; objective?: string; onDraftObjective?: (text: string) => void;
}) {
  const { t } = useI18n();
  if (preview?.readiness.kind !== 'unavailable') return null;
  return <div className="grid justify-items-start gap-2" role="status">
    <p>{t('automation.contextMissing')}</p>
    <button type="button" className={automationButton} {...telemetryClickAttributes('automation.history.open_session', 'automation')}
      onClick={onOpenSession}>{t('automation.openSession')}</button>
  </div>;
}
