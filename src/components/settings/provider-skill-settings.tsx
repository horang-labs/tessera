'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
import type {
  ProviderSkillId,
  ProviderSkillManagementResult,
  ProviderSkillOperation,
  ProviderSkillStatus,
} from '@/lib/cli/provider-skill-management';
import {
  getProviderSkillActions,
  PROVIDER_SKILL_DISPLAY_NAMES,
  shouldOfferProviderSkillOnboarding,
} from '@/lib/cli/provider-skill-view-policy';

const ENDPOINT = '/api/provider-integrations/skills';
async function readResult(response: Response): Promise<ProviderSkillManagementResult> {
  const body = await response.json() as ProviderSkillManagementResult | { error?: unknown };
  if (!response.ok) {
    if ('providers' in body) return body;
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `Provider skill request failed (${response.status}).`,
    );
  }
  return body as ProviderSkillManagementResult;
}

export function ProviderSkillStatusCard({
  status,
  agentEnvironment,
  consented,
  pending,
  onConsentChange,
  onMutate,
}: {
  status: ProviderSkillStatus;
  agentEnvironment: ProviderSkillManagementResult['agentEnvironment'];
  consented: boolean;
  pending: ProviderSkillOperation | null;
  onConsentChange(consented: boolean): void;
  onMutate(operation: Exclude<ProviderSkillOperation, 'status'>): void;
}) {
  const { t } = useI18n();
  const actions = getProviderSkillActions(status);
  const ready = status.state === 'ready';
  const environment = agentEnvironment === 'wsl' ? 'WSL' : 'Native';

  return (
    <article
      className="rounded-2xl border border-(--divider) bg-(--chat-bg)/55 p-4"
      data-testid={`provider-skill-${status.providerId}`}
      data-state={status.state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-medium text-(--text-primary)">{PROVIDER_SKILL_DISPLAY_NAMES[status.providerId]}</h4>
            <span className="rounded-full border border-(--divider) px-2 py-0.5 text-xs font-medium text-(--text-muted)">
              {t('settings.providerSkills.optional')}
            </span>
            {shouldOfferProviderSkillOnboarding(status) ? (
              <span className="rounded-full bg-(--sidebar-hover) px-2 py-0.5 text-xs font-medium text-(--accent)">
                {t('settings.providerSkills.needsConsent')}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-(--text-muted)">
            {t('settings.providerSkills.environment', { environment })}
            {' · '}
            {status.detected
              ? t('settings.providerSkills.detected')
              : t('settings.providerSkills.notDetected')}
          </p>
        </div>
        <span className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
          ready
            ? 'bg-(--sidebar-hover) text-(--success)'
            : status.state === 'conflict' || status.state === 'unavailable'
              ? 'bg-(--sidebar-hover) text-(--error)'
              : 'bg-(--sidebar-hover) text-(--warning)',
        )}>
          {ready
            ? <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
            : <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
          {t(`settings.providerSkills.state.${status.state}`)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-(--text-secondary) sm:grid-cols-2">
        <div>
          <dt className="text-(--text-muted)">{t('settings.providerSkills.consent')}</dt>
          <dd>{t(`settings.providerSkills.consentState.${status.consent}`)}</dd>
        </div>
        <div>
          <dt className="text-(--text-muted)">{t('settings.providerSkills.ownership')}</dt>
          <dd>{t(`settings.providerSkills.ownershipState.${status.ownership}`)}</dd>
        </div>
      </dl>

      {status.state === 'conflict' ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-(--error)">
          {t('settings.providerSkills.conflictHelp', {
            provider: PROVIDER_SKILL_DISPLAY_NAMES[status.providerId],
            environment,
          })}
        </p>
      ) : status.state === 'unavailable' ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-(--warning)">
          {t('settings.providerSkills.unavailableHelp', { environment })}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {actions.canInstall ? (
          <>
            <label className="mr-1 flex basis-full items-start gap-2 text-xs leading-5 text-(--text-secondary)">
              <input
                type="checkbox"
                checked={consented}
                onChange={(event) => onConsentChange(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-(--divider)"
              />
              <span>{t('settings.providerSkills.consentPrompt', {
                provider: PROVIDER_SKILL_DISPLAY_NAMES[status.providerId],
              })}</span>
            </label>
            <button
              type="button"
              onClick={() => onMutate('install')}
              disabled={!consented || pending !== null}
              className="rounded-xl bg-(--accent) px-3 py-2 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
            >
              {pending === 'install' ? t('settings.providerSkills.working') : t('settings.providerSkills.install')}
            </button>
          </>
        ) : null}
        {actions.canUpdate ? (
          <button
            type="button"
            onClick={() => onMutate('update')}
            disabled={pending !== null}
            className="rounded-xl border border-(--divider) px-3 py-2 text-xs font-medium text-(--text-primary) transition-colors hover:bg-(--sidebar-hover) disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pending === 'update' ? t('settings.providerSkills.working') : t('settings.providerSkills.update')}
          </button>
        ) : null}
        {actions.canRemove ? (
          <button
            type="button"
            onClick={() => onMutate('remove')}
            disabled={pending !== null}
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-(--error) transition-colors hover:bg-(--sidebar-hover) disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {pending === 'remove' ? t('settings.providerSkills.working') : t('settings.providerSkills.remove')}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export default function ProviderSkillSettings() {
  const { t } = useI18n();
  const selectedAgentEnvironment = useSettingsStore((state) => state.settings.agentEnvironment);
  const pendingSettingsSaveCount = useSettingsStore((state) => state.pendingSaveCount);
  const requestGeneration = useRef(0);
  const [result, setResult] = useState<ProviderSkillManagementResult | null>(null);
  const [consented, setConsented] = useState<Partial<Record<ProviderSkillId, boolean>>>({});
  const [pending, setPending] = useState<{ providerId: ProviderSkillId; operation: ProviderSkillOperation } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setError(null);
    try {
      const nextResult = await readResult(await fetch(`${ENDPOINT}?all=1`, { cache: 'no-store' }));
      if (requestGeneration.current !== generation) return;
      setResult(nextResult);
      if (!nextResult.success) {
        setError(nextResult.error?.message ?? t('settings.providerSkills.requestFailed'));
      }
    } catch (cause) {
      if (requestGeneration.current !== generation) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [t]);

  useEffect(function loadProviderSkillStatus() {
    requestGeneration.current += 1;
    setResult(null);
    setConsented({});
    setPending(null);
    if (pendingSettingsSaveCount > 0) return;
    void refresh();
  }, [pendingSettingsSaveCount, refresh, selectedAgentEnvironment]);

  const mutate = useCallback(async (
    providerId: ProviderSkillId,
    operation: Exclude<ProviderSkillOperation, 'status'>,
  ) => {
    const generation = ++requestGeneration.current;
    setPending({ providerId, operation });
    setError(null);
    try {
      const mutation = await readResult(await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, providerIds: [providerId] }),
      }));
      if (!mutation.success) throw new Error(mutation.error?.message ?? t('settings.providerSkills.requestFailed'));
      if (requestGeneration.current !== generation) return;
      setConsented((current) => ({ ...current, [providerId]: false }));
      setPending(null);
      await refresh();
    } catch (cause) {
      if (requestGeneration.current !== generation) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestGeneration.current === generation) setPending(null);
    }
  }, [refresh, t]);

  return (
    <div data-testid="provider-skill-settings">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Puzzle className="h-4 w-4 text-(--text-secondary)" aria-hidden="true" />
            <h3 className="font-medium text-(--text-primary)">{t('settings.providerSkills.title')}</h3>
          </div>
          <p className="mt-1 text-sm leading-6 text-(--text-secondary)">
            {t('settings.providerSkills.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pending !== null}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-(--divider) px-3 py-2 text-xs font-medium text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('settings.providerSkills.refresh')}
        </button>
      </div>

      {error ? <p role="alert" className="mt-3 text-sm text-(--error)">{error}</p> : null}
      {result ? (
        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
          {result.providers.map((status) => (
            <ProviderSkillStatusCard
              key={status.providerId}
              status={status}
              agentEnvironment={result.agentEnvironment}
              consented={consented[status.providerId] ?? false}
              pending={pending?.providerId === status.providerId ? pending.operation : null}
              onConsentChange={(value) => setConsented((current) => ({
                ...current,
                [status.providerId]: value,
              }))}
              onMutate={(operation) => void mutate(status.providerId, operation)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
