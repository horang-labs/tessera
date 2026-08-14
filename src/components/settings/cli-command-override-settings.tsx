'use client';

import { useMemo } from 'react';
import { X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import {
  CONFIGURABLE_CLI_PROVIDERS,
  setCliCommandOverride,
} from '@/lib/settings/cli-command-overrides';
import type { AgentEnvironment } from '@/lib/settings/types';
import { cn } from '@/lib/utils';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';

interface CliCommandOverrideSettingsProps {
  environments?: AgentEnvironment[];
  onSaved?: () => void | Promise<void>;
  className?: string;
}

export default function CliCommandOverrideSettings({
  environments,
  onSaved,
  className,
}: CliCommandOverrideSettingsProps) {
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const isWindowsEcosystem = useSettingsStore((state) => state.serverHostInfo?.isWindowsEcosystem ?? false);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const resolvedEnvironments = useMemo<AgentEnvironment[]>(
    () => environments ?? (isWindowsEcosystem ? ['native', 'wsl'] : ['native']),
    [environments, isWindowsEcosystem],
  );

  async function saveCommand(
    providerId: string,
    environment: AgentEnvironment,
    value: string,
  ) {
    const currentValue = settings.cliCommandOverrides?.[providerId]?.[environment] ?? '';
    const nextOverrides = setCliCommandOverride(
      settings.cliCommandOverrides,
      providerId,
      environment,
      value,
    );
    const nextValue = nextOverrides[providerId]?.[environment] ?? '';

    if (nextValue === currentValue) {
      return;
    }

    await updateSettings({ cliCommandOverrides: nextOverrides });
    await onSaved?.();
  }

  return (
    <div className={cn('space-y-3', className)} data-testid="cli-command-overrides">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.cliOverrides.title')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {t('settings.cliOverrides.description')}
        </p>
      </div>

      <div className="space-y-2">
        {CONFIGURABLE_CLI_PROVIDERS.flatMap((provider) => (
          resolvedEnvironments.map((environment) => {
            const value = settings.cliCommandOverrides?.[provider.providerId]?.[environment] ?? '';
            const envLabel = environment === 'wsl'
              ? t('settings.cliStatus.env.wsl')
              : t('settings.cliStatus.env.native');
            const label = resolvedEnvironments.length > 1
              ? t('settings.cliOverrides.commandLabelWithEnv', {
                provider: provider.displayName,
                environment: envLabel,
              })
              : t('settings.cliOverrides.commandLabel', { provider: provider.displayName });

            return (
              <label
                key={`${provider.providerId}-${environment}`}
                className="grid gap-1.5 sm:grid-cols-[minmax(10rem,13rem)_1fr] sm:items-center"
              >
                <span className="text-xs font-medium text-(--text-secondary)">
                  {label}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <input
                    {...settingsTelemetryClickAttributes('settings.development.cli_command_override')}
                    key={`${provider.providerId}-${environment}-${value}`}
                    defaultValue={value}
                    onBlur={(event) => {
                      const nextOverrides = setCliCommandOverride(
                        settings.cliCommandOverrides,
                        provider.providerId,
                        environment,
                        event.target.value,
                      );
                      event.currentTarget.value = nextOverrides[provider.providerId]?.[environment] ?? '';
                      void saveCommand(provider.providerId, environment, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder={getPlaceholder(
                      environment,
                      provider.commandName,
                      isWindowsEcosystem,
                      t,
                    )}
                    className="h-9 min-w-0 flex-1 rounded-md border border-(--input-border) bg-(--input-bg) px-2.5 font-mono text-xs text-(--input-text) outline-none focus:border-(--accent)"
                    data-testid={`cli-command-override-${provider.providerId}-${environment}`}
                  />
                  <button
                    {...settingsTelemetryClickAttributes('settings.development.cli_command_clear')}
                    type="button"
                    onClick={() => {
                      void saveCommand(provider.providerId, environment, '');
                    }}
                    disabled={!value}
                    title={t('settings.cliOverrides.clear')}
                    aria-label={t('settings.cliOverrides.clear')}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              </label>
            );
          })
        ))}
      </div>

      <p className="text-xs leading-5 text-(--text-muted)">
        {t('settings.cliOverrides.help')}
      </p>
    </div>
  );
}

function getPlaceholder(
  environment: AgentEnvironment,
  command: string,
  isWindowsEcosystem: boolean,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (environment === 'wsl') {
    return t('settings.cliOverrides.placeholderWsl', { command });
  }

  if (isWindowsEcosystem) {
    return t('settings.cliOverrides.placeholderNativeWindows', { command });
  }

  return t('settings.cliOverrides.placeholderNativePosix', { command });
}
