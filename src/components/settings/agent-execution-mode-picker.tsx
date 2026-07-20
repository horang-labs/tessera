'use client';

import { Check, MessageSquare, Terminal } from 'lucide-react';
import { useId } from 'react';
import { useI18n } from '@/lib/i18n';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ mode: AgentExecutionMode; icon: typeof Terminal }> = [
  { mode: 'pty', icon: Terminal },
  { mode: 'gui', icon: MessageSquare },
];

interface AgentExecutionModePickerProps {
  value: AgentExecutionMode;
  onChange: (mode: AgentExecutionMode) => void;
  title: string;
  description: string;
  note?: string;
  recommendedMode?: AgentExecutionMode;
  disabled?: boolean;
}

export function AgentExecutionModePicker({
  value,
  onChange,
  title,
  description,
  note,
  recommendedMode,
  disabled = false,
}: AgentExecutionModePickerProps) {
  const { t } = useI18n();
  const groupId = useId();
  const descriptionId = `${groupId}-description`;
  const noteId = `${groupId}-note`;

  return (
    <fieldset
      className="space-y-3"
      disabled={disabled}
      aria-describedby={note ? `${descriptionId} ${noteId}` : descriptionId}
    >
      <legend className="font-medium text-(--text-primary)">{title}</legend>
      <p id={descriptionId} className="-mt-2 text-xs leading-5 text-(--text-muted)">
        {description}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map(({ mode, icon: Icon }) => {
          const selected = value === mode;
          const recommended = recommendedMode === mode;
          const inputId = `${groupId}-${mode}`;

          return (
            <label
              key={mode}
              htmlFor={inputId}
              className={cn(
                'relative flex cursor-pointer gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--accent)',
                selected
                  ? 'border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                  : 'border-(--divider) bg-(--sidebar-bg) hover:border-(--accent)/25',
                disabled && 'cursor-wait opacity-70',
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-(--accent-hover)" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-(--text-primary)">
                    {t(`settings.executionMode.${mode}.label`)}
                  </span>
                  {recommended ? (
                    <span className="rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2 py-0.5 text-[10px] font-semibold text-(--accent-hover)">
                      {t('settings.executionMode.recommended')}
                    </span>
                  ) : null}
                </span>
                <span className="mt-1.5 block text-xs leading-5 text-(--text-muted)">
                  {t(`settings.executionMode.${mode}.description`)}
                </span>
              </span>
              <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                <input
                  type="radio"
                  id={inputId}
                  name={groupId}
                  value={mode}
                  data-testid={`execution-mode-${mode}`}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => onChange(mode)}
                  className="h-4 w-4 appearance-none rounded-full border border-(--input-border) bg-(--input-bg) checked:border-(--accent) checked:bg-(--accent)"
                />
                {selected ? (
                  <Check className="pointer-events-none absolute h-3 w-3 text-white" aria-hidden="true" />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      {note ? (
        <p id={noteId} className="text-xs leading-5 text-(--text-muted)">{note}</p>
      ) : null}
    </fieldset>
  );
}
