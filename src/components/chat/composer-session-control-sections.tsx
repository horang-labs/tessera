'use client';

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  allowCustomModel?: boolean;
  customLabel?: string;
  customPlaceholder?: string;
  customApplyLabel?: string;
  customHint?: string;
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
  stoppedLabel,
  stopLabel,
}: ComposerSessionRunStateProps) {
  if (isRunning) {
    return (
      <button
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
}: ComposerSessionControlMenuProps) {
  return (
    <>
      {options.map((option) => (
        <button
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
  allowCustomModel = false,
  customLabel,
  customPlaceholder,
  customApplyLabel,
  customHint,
}: ComposerModelMenuProps) {
  const isListedModel = modelOptions.some((option) => option.value === selectedModel);
  // Seed the field with the active model when it isn't one of the listed options,
  // so opening the menu shows (and lets you edit) the current custom selection.
  const [customValue, setCustomValue] = useState(() =>
    !isListedModel && selectedModel ? selectedModel : '',
  );

  const submitCustomModel = () => {
    const trimmed = customValue.trim();
    if (trimmed) {
      onSelectModel(trimmed);
    }
  };

  const handleCustomKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitCustomModel();
      return;
    }
    // Let Escape bubble to close the menu; keep every other key (typing, arrows,
    // Home/End) inside the input instead of triggering menu arrow-navigation.
    if (event.key !== 'Escape') {
      event.stopPropagation();
    }
  };

  return (
    <>
      {modelOptions.map((option) => (
        <button
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
      {allowCustomModel && (
        <div className="mt-1 border-t border-(--chat-header-border) px-3 py-2">
          {customLabel && (
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-(--text-muted)">
              {customLabel}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={customValue}
              spellCheck={false}
              autoComplete="off"
              placeholder={customPlaceholder}
              onChange={(event) => setCustomValue(event.target.value)}
              onKeyDown={handleCustomKeyDown}
              className="h-7 min-w-0 flex-1 rounded-md border border-(--divider) bg-(--input-bg) px-2 text-xs text-(--text-primary) outline-none focus:border-(--accent)/50"
            />
            <button
              type="button"
              onClick={submitCustomModel}
              disabled={customValue.trim().length === 0}
              className="h-7 shrink-0 rounded-md border border-(--divider) px-2.5 text-[11px] text-(--text-secondary) transition-colors hover:border-(--accent)/40 hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-50"
            >
              {customApplyLabel}
            </button>
          </div>
          {customHint && (
            <div className="mt-1.5 text-[10px] leading-snug text-(--text-muted)">{customHint}</div>
          )}
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
          data-composer-menu-item
          data-selected={selectedEffort === option.value ? 'true' : undefined}
          onClick={() => onSelect(option.value)}
          className={cn(
            'w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
            selectedEffort === option.value ? 'text-(--accent)' : 'text-(--text-primary)',
          )}
        >
          <div className="font-medium">{option.label}</div>
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
      data-composer-control="reasoning"
      className="composer-quick-access-button inline-flex h-7 items-center gap-1.5 rounded-full border border-(--divider) bg-(--input-bg) px-2.5 text-[11px] text-(--text-muted)"
      title={tooltip}
    >
      <Gauge className="h-3 w-3" />
      <span className="composer-quick-access-label">{label}</span>
    </div>
  );
}
