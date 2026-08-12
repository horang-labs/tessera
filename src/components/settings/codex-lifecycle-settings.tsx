'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ProviderIntegrationLaunchDecision } from '@/lib/cli/provider-integration';
import { getCodexLifecycleActions } from '@/lib/cli/codex-lifecycle-view-policy';

const ENDPOINT = '/api/provider-integrations/codex/lifecycle';

type MutationOperation = 'install' | 'update' | 'remove';

async function readDecision(response: Response): Promise<ProviderIntegrationLaunchDecision> {
  const body = await response.json() as ProviderIntegrationLaunchDecision | { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Codex lifecycle request failed (${response.status}).`,
    );
  }
  return body as ProviderIntegrationLaunchDecision;
}

export default function CodexLifecycleSettings() {
  const { t } = useI18n();
  const [decision, setDecision] = useState<ProviderIntegrationLaunchDecision | null>(null);
  const [consented, setConsented] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [pending, setPending] = useState<'status' | MutationOperation | null>('status');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPending('status');
    setError(null);
    try {
      setDecision(await readDecision(await fetch(ENDPOINT, { cache: 'no-store' })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }, []);

  useEffect(function loadCodexLifecycleStatus() {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(async (operation: MutationOperation) => {
    setPending(operation);
    setError(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(operation === 'install'
          ? { operation, consent: 'granted' }
          : { operation }),
      });
      setDecision(await readDecision(response));
      if (operation === 'install' || operation === 'remove') setConsented(false);
      if (operation === 'remove') setConfirmingRemoval(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }, []);

  const lifecycle = decision?.lifecycle;
  const isHealthy = decision?.health.state === 'healthy';
  const { canInstall, canUpdate, canRemove } = getCodexLifecycleActions(decision);

  return (
    <div data-testid="codex-lifecycle-settings">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-(--text-secondary)" aria-hidden="true" />
            <h3 className="font-medium text-(--text-primary)">
              {t('settings.codexLifecycle.title')}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-6 text-(--text-secondary)">
            {t('settings.codexLifecycle.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={pending !== null}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-(--divider) px-3 py-2 text-xs font-medium text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', pending === 'status' && 'animate-spin')} />
          {t('settings.codexLifecycle.refresh')}
        </button>
      </div>

      {decision ? (
        <div className="mt-4 rounded-xl border border-(--divider) bg-(--chat-bg)/55 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium',
              isHealthy
                ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/12 text-amber-800 dark:text-amber-300',
            )}>
              {isHealthy
                ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                : <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />}
              {t(`settings.codexLifecycle.health.${decision.health.state}`)}
            </span>
            <span className="text-(--text-muted)">
              {t('settings.codexLifecycle.environment', {
                environment: decision.providerHome.agentEnvironment === 'wsl' ? 'WSL' : 'Native',
              })}
            </span>
            <span className="text-(--text-muted)">
              {t('settings.codexLifecycle.consent', {
                consent: t(`settings.codexLifecycle.consentState.${lifecycle?.consent ?? 'unchecked'}`),
              })}
            </span>
          </div>
          {lifecycle?.currentVersion ? (
            <p className="mt-2 text-xs text-(--text-muted)">
              {t('settings.codexLifecycle.version', {
                installed: lifecycle.installedVersion ?? '—',
                current: lifecycle.currentVersion,
              })}
            </p>
          ) : null}
          {lifecycle?.message ? (
            <p className="mt-2 text-sm leading-5 text-amber-800 dark:text-amber-200">
              {lifecycle.message}
            </p>
          ) : null}
          {lifecycle?.state === 'conflict' ? (
            <p className="mt-2 text-xs leading-5 text-(--text-secondary)">
              {t('settings.codexLifecycle.conflictHelp')}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canInstall ? (
          <>
            <label className="mr-2 flex min-w-0 items-start gap-2 text-xs leading-5 text-(--text-secondary)">
              <input
                type="checkbox"
                checked={consented}
                onChange={(event) => setConsented(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-(--divider)"
              />
              <span>{t('settings.codexLifecycle.consentPrompt')}</span>
            </label>
            <button
              type="button"
              onClick={() => void mutate('install')}
              disabled={!consented || pending !== null}
              className="rounded-xl bg-(--accent) px-3 py-2 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
            >
              {pending === 'install'
                ? t('settings.codexLifecycle.working')
                : t('settings.codexLifecycle.install')}
            </button>
          </>
        ) : canRemove ? (
          <>
            <button
              type="button"
              onClick={() => void mutate('update')}
              disabled={!canUpdate || pending !== null}
              className="rounded-xl border border-(--divider) px-3 py-2 text-xs font-medium text-(--text-primary) transition-colors hover:bg-(--sidebar-hover) disabled:cursor-not-allowed disabled:opacity-45"
            >
              {pending === 'update'
                ? t('settings.codexLifecycle.working')
                : t('settings.codexLifecycle.update')}
            </button>
            {confirmingRemoval ? (
              <div className="flex basis-full flex-wrap items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/6 p-3">
                <p className="mr-auto text-xs leading-5 text-(--text-secondary)">
                  {t('settings.codexLifecycle.removeConfirm')}
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmingRemoval(false)}
                  disabled={pending !== null}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-(--text-secondary) hover:bg-(--sidebar-hover)"
                >
                  {t('settings.codexLifecycle.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void mutate('remove')}
                  disabled={pending !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {pending === 'remove'
                    ? t('settings.codexLifecycle.working')
                    : t('settings.codexLifecycle.confirmRemove')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRemoval(true)}
                disabled={pending !== null}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45 dark:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t('settings.codexLifecycle.remove')}
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
