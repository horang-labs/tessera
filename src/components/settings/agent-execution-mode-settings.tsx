'use client';

import { AgentExecutionModePicker } from '@/components/settings/agent-execution-mode-picker';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';
import { useProvidersStore } from '@/stores/providers-store';

export default function AgentExecutionModeSettings() {
  const { t } = useI18n();
  const mode = useSettingsStore((state) => state.settings.agentExecutionMode);
  const isSaving = useSettingsStore((state) => state.pendingSaveCount > 0);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <AgentExecutionModePicker
      value={mode}
      onChange={(nextMode) => void (async () => {
        if (mode === nextMode) return;
        await updateSettings({ agentExecutionMode: nextMode });
        // 모드마다 감지 경로가 다르다(pty: which-only / gui: version+auth).
        // 서버가 새 모드를 읽은 뒤 재프로브해야 하므로 저장 완료 후 refresh.
        useProvidersStore.getState().refresh();
      })()}
      disabled={isSaving}
      title={t('settings.executionMode.title')}
      description={t('settings.executionMode.description')}
      note={t('settings.executionMode.existingSessions')}
    />
  );
}
