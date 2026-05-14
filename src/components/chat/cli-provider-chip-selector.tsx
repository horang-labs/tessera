'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquarePlus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/stores/providers-store';
import type { ProviderMeta } from '@/lib/cli/providers/types';
import { useI18n } from '@/lib/i18n';
import {
  captureTelemetryEvent,
  normalizeTelemetryProviderSetupIssueStatus,
} from '@/lib/telemetry/client';
import { ProviderLogoMark } from './provider-brand';
import { FeedbackDialog } from '@/components/feedback/feedback-dialog';

interface CliProviderChipSelectorProps {
  value: string;
  onChange: (providerId: string) => void;
  className?: string;
  chipClassName?: string;
}

export function CliProviderChipSelector({
  value,
  onChange,
  className,
  chipClassName,
}: CliProviderChipSelectorProps) {
  const { t } = useI18n();
  const providers = useProvidersStore((s) => s.providers);
  const initialized = useProvidersStore((s) => s.initialized);
  const loading = useProvidersStore((s) => s.loading);
  const fetchProviders = useProvidersStore((s) => s.fetch);
  const refreshProviders = useProvidersStore((s) => s.refresh);
  const reportedIssueKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Populate on first mount if the WS onopen hook hasn't fired yet
    // (e.g. store still at initial null). Subsequent mounts reuse the SSoT.
    if (providers === null && !initialized && !loading) {
      fetchProviders();
    }
  }, [providers, initialized, loading, fetchProviders]);

  const list = useMemo(() => providers ?? [], [providers]);
  const selectable = useMemo(() => list.filter((p) => p.status === 'connected'), [list]);
  const needsLogin = useMemo(() => list.filter((p) => p.status === 'needs_login'), [list]);
  const isEmpty = selectable.length === 0;
  const hasOnlyNeedsLogin = isEmpty && needsLogin.length > 0;

  useEffect(() => {
    if (selectable.length === 0) return;
    if (selectable.some((p) => p.id === value)) return;
    onChange(selectable[0].id);
  }, [selectable, onChange, value]);

  useEffect(() => {
    if (providers === null || loading || !initialized || !isEmpty) return;

    if (list.length === 0) {
      const key = 'new_session:all:missing';
      if (!reportedIssueKeysRef.current.has(key)) {
        reportedIssueKeysRef.current.add(key);
        void captureTelemetryEvent('provider_setup_issue_seen', {
          source: 'new_session',
          status: 'missing',
        });
      }
      return;
    }

    for (const provider of list) {
      const issueStatus = normalizeTelemetryProviderSetupIssueStatus(provider.status);
      if (!issueStatus) continue;

      const key = `new_session:${provider.id}:${issueStatus}`;
      if (reportedIssueKeysRef.current.has(key)) continue;
      reportedIssueKeysRef.current.add(key);
      void captureTelemetryEvent('provider_setup_issue_seen', {
        source: 'new_session',
        provider_id: provider.id,
        status: issueStatus,
      });
    }
  }, [initialized, isEmpty, list, loading, providers]);

  if (providers === null) {
    if (loading || !initialized) {
      return (
        <div className={cn('text-[11px] text-(--text-muted)', className)}>
          {t('settings.cliStatus.loadingProviders')}
        </div>
      );
    }

    return (
      <div className={cn('flex items-center gap-2 text-[11px] text-(--text-muted)', className)}>
        <span>{t('settings.cliStatus.providerLoadDelayed')}</span>
        <button
          type="button"
          onClick={refreshProviders}
          className="underline underline-offset-2 text-(--accent-hover) hover:opacity-80"
        >
          {t('settings.cliStatus.refreshProviders')}
        </button>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {selectable.map((provider) => (
          <ProviderChip
            key={provider.id}
            provider={provider}
            isSelected={provider.id === value}
            isSingle={selectable.length === 1}
            onClick={() => selectable.length > 1 && onChange(provider.id)}
            chipClassName={chipClassName}
          />
        ))}
        {needsLogin.map((provider) => (
          <ProviderChip
            key={provider.id}
            provider={provider}
            variant="needs-login"
            chipClassName={chipClassName}
          />
        ))}
        <button
          type="button"
          onClick={refreshProviders}
          disabled={loading}
          title={t('settings.cliStatus.refreshProviders')}
          aria-label="Refresh providers"
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded-full text-(--text-muted) hover:bg-(--input-bg) hover:text-(--text-primary) transition-colors',
            loading && 'animate-spin cursor-wait',
          )}
          data-testid="provider-refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {isEmpty && !loading && (
        <EmptyState
          variant={hasOnlyNeedsLogin ? 'needs-login' : 'not-installed'}
          providers={hasOnlyNeedsLogin ? needsLogin : list}
          onRefresh={refreshProviders}
        />
      )}
    </div>
  );
}

function ProviderChip({
  provider,
  isSelected,
  isSingle,
  onClick,
  variant = 'connected',
  chipClassName,
}: {
  provider: ProviderMeta;
  isSelected?: boolean;
  isSingle?: boolean;
  onClick?: () => void;
  variant?: 'connected' | 'needs-login';
  chipClassName?: string;
}) {
  const { t } = useI18n();

  if (variant === 'needs-login') {
    return (
      <span
        title={t('settings.cliStatus.providerNeedsLoginTooltip', { provider: provider.displayName })}
        className={cn(
          'inline-flex cursor-help items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-[11px] font-medium',
          'border-yellow-500/40 bg-yellow-500/5 text-yellow-600 dark:text-yellow-400',
          chipClassName,
        )}
        data-testid={`provider-chip-${provider.id}`}
        data-status="needs_login"
      >
        <ProviderLogoMark
          providerId={provider.id}
          className="h-3.5 w-3.5 rounded-[3px]"
          iconClassName="h-2.5 w-2.5"
        />
        <span>{provider.displayName}</span>
        <span className="text-[10px] opacity-70">{t('settings.cliStatus.needsLoginShort')}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        isSelected
          ? 'border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-(--accent-hover)'
          : 'border-(--divider) bg-(--input-bg) text-(--text-secondary) hover:border-(--text-muted)/40 hover:text-(--text-primary)',
        isSingle && 'cursor-default',
        chipClassName,
      )}
      data-testid={`provider-chip-${provider.id}`}
      data-status="connected"
    >
      <ProviderLogoMark
        providerId={provider.id}
        className="h-3.5 w-3.5 rounded-[3px]"
        iconClassName="h-2.5 w-2.5"
      />
      <span>{provider.displayName}</span>
    </button>
  );
}

function EmptyState({
  variant,
  providers,
  onRefresh,
}: {
  variant: 'not-installed' | 'needs-login';
  providers: ProviderMeta[];
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);

  if (variant === 'needs-login') {
    const names = providers.map((p) => p.displayName).join(', ');
    return (
      <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-300">
        <div className="font-medium">{t('settings.cliStatus.needsLoginTitle', { providers: names })}</div>
        <div className="mt-0.5 text-yellow-700/80 dark:text-yellow-300/80">
          {t('settings.cliStatus.loginInstructionPrefix')}
          <button
            type="button"
            onClick={onRefresh}
            className="underline underline-offset-2 hover:text-yellow-800 dark:hover:text-yellow-200"
          >
            {t('settings.cliStatus.refreshProviders')}
          </button>
          {t('settings.cliStatus.loginInstructionSuffix')}
        </div>
        <FeedbackButton onClick={() => setIsFeedbackOpen(true)} />
        {isFeedbackOpen && (
          <FeedbackDialog source="cli_error" onClose={() => setIsFeedbackOpen(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-(--divider) bg-(--input-bg) px-2.5 py-2 text-[11px] text-(--text-secondary)">
      <div className="font-medium text-(--text-primary)">{t('settings.cliStatus.noCliAvailable')}</div>
      <div className="mt-0.5">
        {t('settings.cliStatus.installInstructionPrefix')}
        <button
          type="button"
          onClick={onRefresh}
          className="underline underline-offset-2 text-(--accent-hover) hover:opacity-80"
        >
          {t('settings.cliStatus.refreshProviders')}
        </button>
        {t('settings.cliStatus.installInstructionSuffix')}
      </div>
      <FeedbackButton onClick={() => setIsFeedbackOpen(true)} />
      {isFeedbackOpen && (
        <FeedbackDialog source="cli_error" onClose={() => setIsFeedbackOpen(false)} />
      )}
    </div>
  );
}

function FeedbackButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-(--accent-hover) hover:bg-(--sidebar-hover)"
    >
      <MessageSquarePlus className="h-3 w-3" />
      {t('feedback.providerCta')}
    </button>
  );
}
