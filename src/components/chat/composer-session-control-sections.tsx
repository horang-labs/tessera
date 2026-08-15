'use client';

import { Gauge, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ProviderModelOption,
  ProviderReasoningEffortOption,
} from '@/lib/cli/provider-session-options';
import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';
import type { TelemetryUiControl } from '@/lib/telemetry/ui-click';

interface SessionControlMenuOption {
  value: ProviderSessionMode | ProviderSessionAccessMode;
  label: string;
  description: string;
}

interface ComposerSessionRunStateProps {
  isInline: boolean;
  isRunning: boolean;
  isStopped: boolean;
  onStop: () => void;
  stoppedLabel: string;
  stopLabel: string;
}

interface ComposerSessionControlMenuProps {
  footerLabel?: string;
  options: SessionControlMenuOption[];
  selectedValue: ProviderSessionMode | ProviderSessionAccessMode;
  onSelect: (value: ProviderSessionMode | ProviderSessionAccessMode) => void;
  telemetryControl: TelemetryUiControl;
}

interface ComposerModelMenuProps {
  isLoading: boolean;
  modelOptions: ProviderModelOption[];
  selectedModel: string;
  loadingLabel: string;
  onSelectModel: (model: string) => void;
  telemetryControl: TelemetryUiControl;
}

interface ComposerReasoningEffortMenuProps {
  options: ProviderReasoningEffortOption[];
  selectedEffort: string | null;
  onSelect: (effort: string) => void;
  /** Disable spawn-only options (requiresRestart) while the session is running. */
  disableRestartRequired?: boolean;
  restartRequiredTooltip?: string;
  telemetryControl: TelemetryUiControl;
}

interface ComposerReadonlyReasoningBadgeProps {
  label: string;
  tooltip: string;
}

export function ComposerSessionRunState({
  isInline,
  isRunning,
  isStopped,
  onStop,
  stoppedLabel,
  stopLabel,
}: ComposerSessionRunStateProps) {
  if (isRunning) {
    return (
      <button
        {...telemetryClickAttributes('composer.stop', 'composer')}
        type="button"
        onClick={onStop}
        data-composer-control="run-state"
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border border-(--status-success-border) bg-(--status-success-bg) px-2.5 text-[11px] font-medium text-(--status-success-text) transition-colors hover:bg-(--status-success-bg)/80',
          isInline && 'pr-2',
        )}
        data-testid="composer-stop-session"
        title={stopLabel}
        aria-label={stopLabel}
      >
        <span className="h-2 w-2 rounded-full bg-current" />
        <Square className="h-2.5 w-2.5 fill-current" />
      </button>
    );
  }

  if (isStopped) {
    return (
      <div
        data-composer-control="run-state"
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border border-(--divider) bg-(--input-bg) px-2.5 text-[11px] font-medium text-(--text-muted)',
          isInline && 'pr-2',
        )}
      >
        <span className="h-2 w-2 rounded-full bg-current opacity-60" />
        <span>{stoppedLabel}</span>
      </div>
    );
  }

  return null;
}

export function ComposerSessionControlMenu({
  footerLabel,
  options,
  selectedValue,
  onSelect,
  telemetryControl,
}: ComposerSessionControlMenuProps) {
  return (
    <>
      {options.map((option) => (
        <button
          {...telemetryClickAttributes(telemetryControl, 'composer')}
          key={option.value}
          type="button"
          data-composer-menu-item
          data-selected={selectedValue === option.value ? 'true' : undefined}
          onClick={() => onSelect(option.value)}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
            selectedValue === option.value ? 'text-(--accent)' : 'text-(--text-primary)',
          )}
        >
          <div className="font-medium">{option.label}</div>
          <div className="mt-0.5 text-[10px] text-(--text-muted)">{option.description}</div>
        </button>
      ))}
      {footerLabel && (
        <div className="mt-1 border-t border-(--chat-header-border) px-3 py-2 text-[10px] text-(--text-muted)">
          {footerLabel}
        </div>
      )}
    </>
  );
}

export function ComposerModelMenu({
  isLoading,
  modelOptions,
  selectedModel,
  loadingLabel,
  onSelectModel,
  telemetryControl,
}: ComposerModelMenuProps) {
  return (
    <>
      {modelOptions.map((option) => (
        <button
          {...telemetryClickAttributes(telemetryControl, 'composer')}
          key={option.value}
          type="button"
          data-composer-menu-item
          data-selected={selectedModel === option.value ? 'true' : undefined}
          onClick={() => onSelectModel(option.value)}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
            selectedModel === option.value ? 'text-(--accent)' : 'text-(--text-primary)',
          )}
        >
          <div className="font-medium">{option.label}</div>
          {option.description && (
            <div className="mt-0.5 text-[10px] text-(--text-muted)">{option.description}</div>
          )}
        </button>
      ))}
      {isLoading && (
        <div className="px-3 py-2 text-[10px] text-(--text-muted)">
          {loadingLabel}
        </div>
      )}
    </>
  );
}

export function ComposerReasoningEffortMenu({
  options,
  selectedEffort,
  onSelect,
  disableRestartRequired,
  restartRequiredTooltip,
  telemetryControl,
}: ComposerReasoningEffortMenuProps) {
  return (
    <>
      {options.map((option) => {
        const isDisabled = disableRestartRequired === true && option.requiresRestart === true;
        return (
          <button
            {...telemetryClickAttributes(telemetryControl, 'composer')}
            key={option.value}
            type="button"
            data-composer-menu-item
            data-selected={selectedEffort === option.value ? 'true' : undefined}
            disabled={isDisabled}
            title={isDisabled ? restartRequiredTooltip : undefined}
            onClick={() => onSelect(option.value)}
            className={cn(
              'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
              selectedEffort === option.value ? 'text-(--accent)' : 'text-(--text-primary)',
            )}
          >
            <div className="font-medium">{option.label}</div>
            <div className="mt-0.5 text-[10px] text-(--text-muted)">{option.description}</div>
          </button>
        );
      })}
    </>
  );
}

export function ComposerReadonlyReasoningBadge({
  label,
  tooltip,
}: ComposerReadonlyReasoningBadgeProps) {
  return (
    <div
      data-composer-control="reasoning"
      className="composer-quick-access-button inline-flex h-7 items-center gap-1.5 rounded-full border border-(--divider) bg-(--input-bg) px-2.5 text-[11px] text-(--text-muted)"
      title={tooltip}
    >
      <Gauge className="h-3 w-3" />
      <span className="composer-quick-access-label">{label}</span>
    </div>
  );
}
