'use client';
import { useI18n } from '@/lib/i18n';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
export function AutomationReason({ reason, summary }: { reason: string | null; summary?: string | null }) {
  const { t } = useI18n();
  if (!reason) return summary ? <p className="text-xs whitespace-pre-wrap">{summary}</p> : null;
  const key = /CONTEXT|OBJECTIVE|BOUNDARY|IDENTITY|STALE/.test(reason) ? 'reasonContext'
    : /SUPERVISOR|ANALYSIS/.test(reason) ? 'reasonSupervisor'
    : /APPROVAL|PERMISSION|QUESTION/.test(reason) ? 'reasonApproval'
    : /LIMIT|EXPIR/.test(reason) ? 'reasonLimit'
    : /UNCERTAIN|UNKNOWN/.test(reason) ? 'reasonUnknown' : 'reasonPaused';
  return <div className="text-xs">{summary && <p className="whitespace-pre-wrap">{summary}</p>}<p>{t(`automation.${key}`)}</p><details><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')}>{t('automation.diagnostics')}</summary><code>{reason}</code></details></div>;
}
