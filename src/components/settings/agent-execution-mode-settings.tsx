'use client';

import { MessageSquare, Terminal } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

const OPTIONS: Array<{ mode: AgentExecutionMode; icon: typeof Terminal }> = [
  { mode: 'pty', icon: Terminal },
  { mode: 'gui', icon: MessageSquare },
];

export default function AgentExecutionModeSettings() {
  const { t } = useI18n();
  const mode = useSettingsStore((state) => state.settings.agentExecutionMode);
  const isSaving = useSettingsStore((state) => state.pendingSaveCount > 0);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.executionMode.title')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {t('settings.executionMode.description')}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('settings.executionMode.title')}>
        {OPTIONS.map(({ mode: optionMode, icon: Icon }) => {
          const selected = mode === optionMode;
          return (
            <button
              key={optionMode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={isSaving}
              onClick={() => void updateSettings({ agentExecutionMode: optionMode })}
              className={cn(
                'rounded-xl border px-3 py-3 text-left transition-colors',
                selected
                  ? 'border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                  : 'border-(--divider) bg-(--sidebar-bg) hover:border-(--accent)/25',
                isSaving && 'cursor-wait opacity-70',
              )}
              data-testid={`execution-mode-${optionMode}`}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-(--accent-hover)" />
                <span className="text-sm font-medium text-(--text-primary)">
                  {t(`settings.executionMode.${optionMode}.label`)}
                </span>
              </span>
              <span className="mt-1.5 block text-xs leading-5 text-(--text-muted)">
                {t(`settings.executionMode.${optionMode}.description`)}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs leading-5 text-(--text-muted)">
        {t('settings.executionMode.existingSessions')}
      </p>
    </div>
  );
}
