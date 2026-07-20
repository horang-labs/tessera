'use client';

import { useI18n } from '@/lib/i18n';
import {
  getProviderExecutionCapabilities,
  type AgentExecutionMode,
} from '@/lib/session/agent-execution-mode';
import { cn } from '@/lib/utils';

export function ProviderExecutionBadge({
  className,
  preferredMode,
  providerId,
  testId,
}: {
  className?: string;
  preferredMode: AgentExecutionMode;
  providerId: string;
  testId: string;
}) {
  const { t } = useI18n();
  const capabilities = getProviderExecutionCapabilities(providerId);
  if (preferredMode !== 'gui' || capabilities.gui || !capabilities.pty) return null;

  return (
    <span
      className={cn(
        'rounded-full bg-(--chat-bg) px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-(--text-muted)',
        className,
      )}
      data-testid={testId}
    >
      {t('settings.executionMode.ptyOnly')}
    </span>
  );
}
