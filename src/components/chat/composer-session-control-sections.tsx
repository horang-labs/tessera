'use client';

import { Gauge, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ProviderModelOption,
  ProviderReasoningEffortOption,
} from '@/lib/cli/provider-session-options';
import type { ProviderSessionAccessMode, ProviderSessionMode } from '@/lib/session/session-control-types';

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
  runningLabel: string;
  stoppedLabel: string;
  stopLabel: string;
}

interface ComposerSessionControlMenuProps {
  footerLabel?: string;
  options: SessionControlMenuOption[];
  selectedValue: ProviderSessionMode | ProviderSessionAccessMode;
  onSelect: (value: ProviderSessionMode | ProviderSessionAccessMode) => void;
}

interface ComposerModelMenuProps {
  isLoading: boolean;
  modelOptions: ProviderModelOption[];
  selectedModel: string;
  loadingLabel: string;
  onSelectModel: (model: string) => void;
}

interface ComposerReasoningEffortMenuProps {
  options: ProviderReasoningEffortOption[];
  selectedEffort: string | null;
  onSelect: (effort: string) => void;
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
  runningLabel,
  stoppedLabel,
  stopLabel,
}: ComposerSessionRunStateProps) {
  if (isRunning) {
    return (
      <button
        type="button"
        onClick={onStop}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border border-(--status-success-border) bg-(--status-success-bg) px-2.5 text-[11px] font-medium text-(--status-success-text) transition-colors hover:bg-(--status-success-bg)/80',
          isInline && 'pr-2',
        )}
        data-testid="composer-stop-session"
        title={stopLabel}
        aria-label={stopLabel}
      >
        <span className="h-2 w-2 rounded-full bg-current" />
        <span>{runningLabel}</span>
        <span className="h-3.5 w-px bg-current/25" />
        <Square className="h-2.5 w-2.5 fill-current" />
      </button>
    );
  }

  if (!isStopped) {
    return null;
  }

  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-(--divider) bg-(--input-bg) px-2 text-[11px] text-(--text-muted)">
      <span className="h-2 w-2 rounded-full bg-current" />
      <span className="h-2 w-2 rounded-full border border-current" />
      {stoppedLabel}
    </span>
  );
}

export function ComposerSessionControlMenu({
  footerLabel,
  options,
  selectedValue,
  onSelect,
}: ComposerSessionControlMenuProps) {
  return (
    <>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(option.value)}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover)',
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
}: ComposerModelMenuProps) {
  return (
    <>
      {modelOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelectModel(option.value)}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover)',
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
}: ComposerReasoningEffortMenuProps) {
  return (
    <>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(option.value)}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover)',
            selectedEffort === option.value ? 'text-(--accent)' : 'text-(--text-primary)',
          )}
        >
          <div className="font-medium">{option.value}</div>
          <div className="mt-0.5 text-[10px] text-(--text-muted)">{option.description}</div>
        </button>
      ))}
    </>
  );
}

export function ComposerReadonlyReasoningBadge({
  label,
  tooltip,
}: ComposerReadonlyReasoningBadgeProps) {
  return (
    <div
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-(--divider) bg-(--input-bg) px-2.5 text-[11px] text-(--text-muted)"
      title={tooltip}
    >
      <Gauge className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}
