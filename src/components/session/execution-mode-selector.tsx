'use client';

import { Check } from 'lucide-react';
import { useId } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  getProviderExecutionCapabilities,
  type AgentExecutionMode,
  type ProviderExecutionCapabilities,
} from '@/lib/session/agent-execution-mode';
import { cn } from '@/lib/utils';

export type ExecutionModeSelectorDensity = 'regular' | 'compact';

export interface ExecutionModeSelectorProps {
  value: AgentExecutionMode;
  onChange: (mode: AgentExecutionMode) => void;
  providerId: string;
  density?: ExecutionModeSelectorDensity;
  className?: string;
  name?: string;
}

export function getExecutionModeSelectorOptions(
  value: AgentExecutionMode,
  capabilities: ProviderExecutionCapabilities,
) {
  return (['pty', 'gui'] as const).map((mode) => ({
    mode,
    checked: mode === value,
    disabled: !capabilities[mode],
  }));
}

export function ExecutionModeSelector({
  value,
  onChange,
  providerId,
  density = 'regular',
  className,
  name,
}: ExecutionModeSelectorProps) {
  const { t } = useI18n();
  const generatedName = useId();
  const capabilities = getProviderExecutionCapabilities(providerId);
  const options = getExecutionModeSelectorOptions(value, capabilities);
  const compact = density === 'compact';

  return (
    <div className={className} data-density={density}>
      <div
        className={cn(
          'gap-0.5 rounded-lg border border-(--divider) p-0.5',
          compact
            ? 'grid w-full grid-cols-2 bg-[color-mix(in_srgb,var(--input-bg)_78%,var(--sidebar-bg))]'
            : 'inline-flex max-w-full bg-(--sidebar-bg)',
        )}
        role="radiogroup"
      >
        {options.map(({ mode, checked, disabled }) => {
          const fullLabel = t(`settings.executionMode.${mode}.label`);
          const label = compact
            ? fullLabel.replace(/\s*\((PTY|GUI)\)$/, ' · $1')
            : fullLabel;
          const description = t(`settings.executionMode.${mode}.description`);
          const disabledReason = disabled ? t('settings.executionMode.unsupported') : undefined;
          return (
            <label
              key={mode}
              title={disabledReason ?? description}
              className={cn(
                'relative flex min-w-0 items-center gap-1.5 rounded-md border transition-colors',
                compact ? 'px-1.5 py-1.5' : 'px-1.5 py-1',
                checked
                  ? compact
                    ? 'border-transparent bg-[color-mix(in_srgb,var(--accent)_14%,var(--input-bg))] text-(--text-primary)'
                    : 'border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] text-(--text-primary)'
                  : compact
                    ? 'border-transparent text-(--text-secondary) hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] hover:text-(--text-primary)'
                    : 'border-transparent text-(--text-muted) hover:bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]',
                disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent',
                !disabled && 'cursor-pointer',
              )}
              data-testid={`execution-mode-${mode}`}
            >
              <input
                type="radio"
                name={name ?? generatedName}
                value={mode}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(mode)}
                className="h-3 w-3 shrink-0 rounded-full accent-(--accent) outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--input-bg)"
                aria-describedby={disabled ? `${generatedName}-${mode}-reason` : undefined}
              />
              <span className="min-w-0">
                <span className={cn('block truncate font-medium', compact ? 'text-[9px]' : 'text-[10px]')}>
                  {label}
                </span>
              </span>
              {checked && <Check className="h-3 w-3 shrink-0 text-(--accent-hover)" aria-hidden="true" />}
              {disabled && (
                <span id={`${generatedName}-${mode}-reason`} className="sr-only">
                  {disabledReason}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
