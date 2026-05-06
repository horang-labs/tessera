'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';
import type { AgentEnvironment } from '@/lib/settings/types';

type ToolStatus = 'ready' | 'missing' | 'needs_login' | 'needs_config';
type ToolKey = 'git' | 'gh';

interface ToolState {
  status: ToolStatus;
  version?: string;
}

interface EnvironmentState {
  git: ToolState;
  gh: ToolState;
}

interface SetupStatusPayload {
  activeEnvironment: AgentEnvironment;
  availableEnvironments: AgentEnvironment[];
  isWindowsEcosystem: boolean;
  environments: Partial<Record<AgentEnvironment, EnvironmentState>>;
}

const TOOL_ORDER: ToolKey[] = ['git', 'gh'];

const STATUS_DOT_CLASS: Record<ToolStatus, string> = {
  ready: 'bg-green-500',
  missing: 'bg-gray-400',
  needs_login: 'bg-yellow-500',
  needs_config: 'bg-yellow-500',
};

export default function ToolStatusList() {
  const { t } = useI18n();
  const agentEnvironment = useSettingsStore((state) => state.settings.agentEnvironment);
  const [status, setStatus] = useState<SetupStatusPayload | null | undefined>(null);

  const fetchStatus = useCallback(async () => {
    setStatus(null);
    try {
      const response = await fetch('/api/setup/status');
      if (!response.ok) throw new Error('Failed to load setup status');
      setStatus(await response.json() as SetupStatusPayload);
    } catch {
      setStatus(undefined);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus, agentEnvironment]);

  const statusLabels: Record<ToolStatus, string> = {
    ready: t('setup.ready'),
    missing: t('setup.missing'),
    needs_login: t('setup.needsLogin'),
    needs_config: t('setup.needsConfig'),
  };

  const toolLabels: Record<ToolKey, string> = {
    git: t('setup.git'),
    gh: t('setup.gh'),
  };

  function getEnvironmentLabel(environment: AgentEnvironment): string {
    if (environment === 'wsl') return t('setup.wslTools');
    return status?.isWindowsEcosystem ? t('setup.windowsTools') : t('setup.usingLocalTools');
  }

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-(--text-primary)">
          {t('setup.git')} / {t('setup.gh')}
        </h4>
        <p className="mt-1 text-xs text-(--text-muted)">
          {agentEnvironment === 'wsl' ? t('setup.usingWslTools') : getEnvironmentLabel('native')}
        </p>
      </div>

      {status === null && (
        <div role="status" className="text-sm text-(--text-muted)">
          {t('setup.loading')}
        </div>
      )}

      {status === undefined && (
        <div role="status" className="text-sm text-(--text-muted)">
          {t('setup.loadFailed')}
        </div>
      )}

      {status && (
        <div className="grid gap-2 sm:grid-cols-2">
          {status.availableEnvironments.map((environment) => {
            const environmentState = status.environments[environment];
            if (!environmentState) return null;
            const isActive = status.activeEnvironment === environment;

            return (
              <div
                key={environment}
                className="rounded-lg border border-(--divider) bg-(--chat-bg) p-3"
                data-testid={`tool-status-${environment}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-(--text-primary)">
                    {getEnvironmentLabel(environment)}
                  </p>
                  {isActive && (
                    <span className="rounded-full border border-(--divider) px-2 py-0.5 text-[11px] text-(--text-muted)">
                      {t('settings.cliStatus.active')}
                    </span>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {TOOL_ORDER.map((tool) => {
                    const toolState = environmentState[tool];
                    return (
                      <div key={tool} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-(--text-primary)">{toolLabels[tool]}</span>
                        <span className="flex min-w-0 items-center gap-2 text-(--text-muted)">
                          <span
                            aria-hidden
                            className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[toolState.status]}`}
                          />
                          <span className="truncate">{statusLabels[toolState.status]}</span>
                          {toolState.version && (
                            <span className="truncate opacity-70">{toolState.version}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void fetchStatus()}
          disabled={status === null}
          className="rounded-md border border-(--divider) px-2 py-1 text-xs text-(--text-primary) hover:bg-(--sidebar-hover) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          {t('settings.cliStatus.refresh')}
        </button>
      </div>
    </div>
  );
}
