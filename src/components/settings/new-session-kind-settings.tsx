'use client';

import { useId } from 'react';
import { MessageSquare, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';
import type { NewSessionDefaultKind } from '@/lib/settings/types';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';

const OPTIONS: ReadonlyArray<{
  kind: NewSessionDefaultKind;
  icon: typeof MessageSquare;
}> = [
  { kind: 'chat', icon: MessageSquare },
  { kind: 'task', icon: ListTodo },
];

/**
 * Which option the session creation surfaces preselect: a plain chat session in
 * the project, or a worktree task. Separate from the execution-mode setting
 * above it, which decides the PTY-vs-GUI interface of whatever gets created.
 */
export default function NewSessionKindSettings() {
  const { t } = useI18n();
  const value = useSettingsStore((state) => state.settings.defaultNewSessionKind);
  const isSaving = useSettingsStore((state) => state.pendingSaveCount > 0);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  const groupId = useId();
  const descriptionId = `${groupId}-description`;
  const noteId = `${groupId}-note`;

  return (
    <fieldset
      className="space-y-3"
      disabled={isSaving}
      aria-describedby={`${descriptionId} ${noteId}`}
    >
      <legend className="font-medium text-(--text-primary)">
        {t('settings.newSessionKind.title')}
      </legend>
      <p id={descriptionId} className="-mt-2 text-xs leading-5 text-(--text-muted)">
        {t('settings.newSessionKind.description')}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map(({ kind, icon: Icon }) => {
          const selected = value === kind;
          const inputId = `${groupId}-${kind}`;

          return (
            <label
              {...settingsTelemetryClickAttributes('settings.general.new_session_kind')}
              key={kind}
              htmlFor={inputId}
              className={cn(
                'relative flex cursor-pointer gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--accent)',
                selected
                  ? 'border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                  : 'border-(--divider) bg-(--sidebar-bg) hover:border-(--accent)/25',
                isSaving && 'cursor-wait opacity-70',
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-(--accent-hover)" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium text-(--text-primary)">
                  {t(`settings.newSessionKind.${kind}.label`)}
                </span>
                <span className="mt-1.5 block text-xs leading-5 text-(--text-muted)">
                  {t(`settings.newSessionKind.${kind}.description`)}
                </span>
              </span>
              <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                <input
                  {...settingsTelemetryClickAttributes('settings.general.new_session_kind')}
                  type="radio"
                  id={inputId}
                  name={groupId}
                  value={kind}
                  data-testid={`new-session-kind-${kind}`}
                  checked={selected}
                  onChange={() => {
                    if (selected) return;
                    void updateSettings({ defaultNewSessionKind: kind });
                  }}
                  className="h-4 w-4 accent-(--accent)"
                />
              </span>
            </label>
          );
        })}
      </div>

      <p id={noteId} className="text-xs leading-5 text-(--text-muted)">
        {t('settings.newSessionKind.note')}
      </p>
    </fieldset>
  );
}
