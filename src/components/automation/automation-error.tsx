'use client';
import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { automationReasonKey } from './automation-reason';
import { automationDiagnosticsDisclosure } from './automation-layout';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useI18n } from '@/lib/i18n';

export function AutomationError({ code, recovery }: { code: string | null; recovery?: ReactNode }) {
  const { t } = useI18n();
  if (!code) return null;
  const reason = automationReasonKey(code, 'request');
  const key = code === 'REVISION_CONFLICT' ? 'conflict' : code === 'RUNTIME_ADAPTER_UNAVAILABLE' || code === 'OWNER_UNAVAILABLE' ? 'adapter' : reason === 'reasonRequest' ? 'error' : reason === 'reasonSupervisor' ? 'supervisorSetupFailed' : reason;
  return <div className="grid min-w-0 gap-2 border-l-2 border-(--status-error-border) pl-3 text-xs leading-relaxed">
    <div className="flex items-start gap-2"><AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-(--status-error-text)" /><p role="alert" className="min-w-0 break-words text-(--status-error-text)">{t(`automation.${key}`)}</p></div>
    {recovery && <div className="flex flex-wrap items-center gap-2">{recovery}</div>}
    <details className={automationDiagnosticsDisclosure}><summary {...telemetryClickAttributes('automation.diagnostics', 'automation')}>{t('automation.technicalDetails')}</summary><code className="break-words">{code}</code></details>
  </div>;
}
