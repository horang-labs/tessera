'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { AgentEnvironment } from '@/lib/settings/types';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';

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
  const [pendingChange, setPendingChange] = useState<{
    target: AgentEnvironment;
    unavailableCount: number;
  } | null>(null);
  const shouldShow = isWindowsServer ?? storeIsWindowsServer;

  if (!shouldShow) return null;

  async function requestEnvironmentChange(target: AgentEnvironment) {
    if (target === agentEnvironment) return;
    const response = await fetch(
      `/api/settings/provider-home-impact?target=${encodeURIComponent(target)}`,
    );
    if (!response.ok) return;
    const impact = await response.json() as { unavailableManagedSessionCount?: number };
    const unavailableCount = impact.unavailableManagedSessionCount ?? 0;
    if (unavailableCount === 0) {
      await updateSettings({ agentEnvironment: target });
      return;
    }
    setPendingChange({ target, unavailableCount });
  }

  return (
    <>
      <div className="space-y-2">
        <h3 className="font-medium text-(--text-primary)">{t('settings.agentEnv.label')}</h3>
        <p className="text-xs text-(--text-muted)">{t('settings.agentEnv.desc')}</p>
        <select
          value={agentEnvironment}
          onChange={(e) => void requestEnvironmentChange(e.target.value as AgentEnvironment)}
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
      <AsyncConfirmDialog
        open={pendingChange !== null}
        onCancel={() => setPendingChange(null)}
        onConfirm={async () => {
          if (!pendingChange) return;
          await updateSettings(
            { agentEnvironment: pendingChange.target },
            { confirmProviderHomeChange: true },
          );
          setPendingChange(null);
        }}
        title={t('settings.agentEnv.changeTitle')}
        description={t('settings.agentEnv.changeDescription', {
          count: pendingChange?.unavailableCount ?? 0,
        })}
        icon={AlertTriangle}
        cancelLabel={t('settings.agentEnv.cancelChange')}
        confirmLabel={t('settings.agentEnv.confirmChange')}
        confirmingLabel={t('settings.agentEnv.changing')}
        iconContainerClassName="bg-amber-500/10"
        iconClassName="text-amber-500"
      />
    </>
  );
}
