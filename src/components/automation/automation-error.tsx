'use client';
import { useI18n } from '@/lib/i18n';

export function AutomationError({ code }: { code: string | null }) {
  const { t } = useI18n();
  if (!code) return null;
  const key = code === 'REVISION_CONFLICT' ? 'conflict' : code === 'RUNTIME_ADAPTER_UNAVAILABLE' || code === 'OWNER_UNAVAILABLE' ? 'adapter' : 'error';
  return <p role="alert" className="break-words text-xs text-red-500">{t(`automation.${key}`)} ({code})</p>;
}
