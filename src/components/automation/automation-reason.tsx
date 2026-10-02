'use client';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes as click } from '@/lib/telemetry/ui-click';
export function AutomationReason({ reason }: { reason: string | null }) {
  const { t } = useI18n();
  if (!reason) return null;
  const key = /CONTEXT|OBJECTIVE|BOUNDARY|IDENTITY|STALE/.test(reason) ? 'reasonContext'
    : /SUPERVISOR|ANALYSIS/.test(reason) ? 'reasonSupervisor'
    : /APPROVAL|PERMISSION|QUESTION/.test(reason) ? 'reasonApproval'
    : /LIMIT|EXPIR/.test(reason) ? 'reasonLimit'
    : /UNCERTAIN|UNKNOWN/.test(reason) ? 'reasonUnknown' : 'reasonPaused';
  return <div className="text-xs"><p>{t(`automation.${key}`)}</p><details><summary {...click('automation.diagnostics', 'automation')}>{t('automation.diagnostics')}</summary><code>{reason}</code></details></div>;
}
