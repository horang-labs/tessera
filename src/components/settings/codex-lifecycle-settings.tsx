'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ProviderIntegrationLaunchDecision } from '@/lib/cli/provider-integration';
import { useSettingsStore } from '@/stores/settings-store';

const ENDPOINT = '/api/provider-integrations/codex/lifecycle';

async function readDecision(response: Response): Promise<ProviderIntegrationLaunchDecision> {
  const body = await response.json() as ProviderIntegrationLaunchDecision | { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof (body as { error?: unknown }).error === 'string'
      ? String((body as { error: string }).error)
      : `Codex lifecycle request failed (${response.status}).`);
  }
  return body as ProviderIntegrationLaunchDecision;
}

export default function CodexLifecycleSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.settings.codexLifecycleHooksEnabled);
  const environment = useSettingsStore((state) => state.settings.agentEnvironment);
  const pendingSettingsSaveCount = useSettingsStore((state) => state.pendingSaveCount);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const generation = useRef(0);
  const [decision, setDecision] = useState<ProviderIntegrationLaunchDecision | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (operation?: 'reconcile' | 'remove') => {
    const current = ++generation.current;
    setPending(true);
    setError(null);
    try {
      const response = operation
        ? await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operation }),
          })
        : await fetch(ENDPOINT, { cache: 'no-store' });
      const next = await readDecision(response);
      if (generation.current === current) setDecision(next);
    } catch (cause) {
      if (generation.current === current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation.current === current) setPending(false);
    }
  }, []);

  useEffect(() => {
    if (pendingSettingsSaveCount > 0) return;
    void refresh();
  }, [environment, pendingSettingsSaveCount, refresh]);

  const toggle = useCallback(async () => {
    const nextEnabled = !enabled;
    await updateSettings({ codexLifecycleHooksEnabled: nextEnabled });
    if (useSettingsStore.getState().settings.codexLifecycleHooksEnabled !== nextEnabled) return;
    await refresh(nextEnabled ? 'reconcile' : 'remove');
  }, [enabled, refresh, updateSettings]);

  const healthy = enabled && decision?.health.state === 'healthy';
  const status = !enabled ? 'Off' : pending ? 'Checking' : healthy ? 'Installed' : 'Needs attention';

  return (
    <section data-testid="codex-lifecycle-settings">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-(--text-secondary)" aria-hidden="true" />
            <h3 className="font-medium text-(--text-primary)">{t('settings.codexLifecycle.title')}</h3>
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              healthy ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/12 text-amber-800 dark:text-amber-300',
            )}>
              {healthy ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
              {status}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-(--text-secondary)">
            Shows working, waiting, and done states for managed Codex sessions.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Agent status hooks"
          data-testid="codex-lifecycle-toggle"
          disabled={pending || pendingSettingsSaveCount > 0}
          onClick={() => void toggle()}
          className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', enabled ? 'bg-(--accent)' : 'bg-(--divider)')}
        >
          <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', enabled ? 'translate-x-5' : 'translate-x-0.5')} />
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-(--divider) bg-(--chat-bg)/55 p-3 text-sm">
        <p className="text-(--text-secondary)">
          {enabled
            ? `Tessera keeps the hook installed in the ${environment === 'wsl' ? 'WSL' : 'Native'} Codex home before launch.`
            : 'Codex launches are blocked while Agent status hooks are off. Turn them on to launch Codex.'}
        </p>
        {decision?.lifecycle.message ? <p className="mt-2 text-amber-700 dark:text-amber-300">{decision.lifecycle.message}</p> : null}
        {decision?.guidance?.updateCommand ? <code className="mt-2 block rounded-lg bg-black/10 px-3 py-2 text-xs dark:bg-white/8">{decision.guidance.updateCommand}</code> : null}
        {error ? <p role="alert" className="mt-2 text-(--error)">{error}</p> : null}
        <button
          type="button"
          onClick={() => void refresh(enabled ? 'reconcile' : undefined)}
          disabled={pending}
          className="mt-3 inline-flex items-center gap-2 rounded-xl border border-(--divider) px-3 py-2 text-xs font-medium text-(--text-primary) disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', pending && 'animate-spin')} />
          {error ? 'Retry' : 'Re-check'}
        </button>
      </div>
    </section>
  );
}
