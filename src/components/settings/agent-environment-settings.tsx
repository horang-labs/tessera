'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { AgentEnvironment } from '@/lib/settings/types';

const ENVIRONMENTS: { value: AgentEnvironment; labelKey: string; descKey: string }[] = [
  { value: 'native', labelKey: 'settings.agentEnv.native', descKey: 'settings.agentEnv.nativeDesc' },
  { value: 'wsl', labelKey: 'settings.agentEnv.wsl', descKey: 'settings.agentEnv.wslDesc' },
];

interface AgentEnvironmentSettingsProps {
  isWindowsServer?: boolean;
}

export default function AgentEnvironmentSettings({ isWindowsServer }: AgentEnvironmentSettingsProps) {
  const { t } = useI18n();
  const agentEnvironment = useSettingsStore((state) => state.settings.agentEnvironment);
  const storeIsWindowsServer = useSettingsStore((state) => state.serverHostInfo?.isWindowsEcosystem ?? false);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const shouldShow = isWindowsServer ?? storeIsWindowsServer;

  if (!shouldShow) return null;

  return (
    <div className="space-y-2">
      <h3 className="font-medium text-(--text-primary)">{t('settings.agentEnv.label')}</h3>
      <p className="text-xs text-(--text-muted)">{t('settings.agentEnv.desc')}</p>
      <select
        value={agentEnvironment}
        onChange={(e) => updateSettings({ agentEnvironment: e.target.value as AgentEnvironment })}
        className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
      >
        {ENVIRONMENTS.map((env) => (
          <option key={env.value} value={env.value}>
            {t(env.labelKey as any)}
          </option>
        ))}
      </select>
      <p className="text-xs text-(--text-muted)">
        {t(ENVIRONMENTS.find((e) => e.value === agentEnvironment)?.descKey as any)}
      </p>
    </div>
  );
}
