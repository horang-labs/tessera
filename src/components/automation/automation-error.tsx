'use client';
import { AutomationReason } from './automation-reason';
import { useI18n } from '@/lib/i18n';

export function AutomationError({ code }: { code: string | null }) {
  const { t } = useI18n();
  if (!code) return null;
  const key = code === 'REVISION_CONFLICT' ? 'conflict' : code === 'RUNTIME_ADAPTER_UNAVAILABLE' || code === 'OWNER_UNAVAILABLE' ? 'adapter' : 'error';
  return <div className="grid gap-2 rounded-lg border border-(--status-error-border) bg-(--status-error-bg) p-3"><AutomationReason reason={code} context="request" /><p role="alert" className="break-words text-xs text-(--status-error-text)">{t(`automation.${key}`)}</p></div>;
}
