'use client';

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Shield, Cpu, Gauge, Square, ChevronDown, Workflow } from 'lucide-react';
import { useSessionStore } from '@/stores/session-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { wsClient } from '@/lib/ws/client';
import type { PermissionMode } from '@/lib/ws/message-types';
import type {
  ProviderRuntimeControls,
  ProviderSessionAccessMode,
  ProviderSessionMode,
} from '@/lib/session/session-control-types';
import type {
  ProviderAccessOption,
  ProviderModelOption,
  ProviderSessionOptions,
} from '@/lib/cli/provider-session-options';
import {
  buildProviderSessionDefaultsUpdate,
  getProviderSessionDefaults,
  resolveProviderPermissionMode,
  resolveProviderRuntimeControls,
} from '@/lib/settings/provider-defaults';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import type { UnifiedSession } from '@/types/chat';
import {
  ComposerModelMenu,
  ComposerReadonlyReasoningBadge,
  ComposerReasoningEffortMenu,
  ComposerSessionControlMenu,
  ComposerSessionRunState,
} from './composer-session-control-sections';

const FALLBACK_CLAUDE_ACCESS_OPTIONS: ProviderAccessOption[] = [
  { value: 'default', label: 'Default', description: 'Ask before edits and risky commands' },
  { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve file edits' },
  { value: 'dontAsk', label: "Don't Ask", description: 'Block unapproved actions without prompting' },
  { value: 'bypassPermissions', label: 'YOLO', description: 'Bypass prompts in isolated environments only' },
];

const FALLBACK_CODEX_ACCESS_OPTIONS: ProviderAccessOption[] = [
  { value: 'readOnly', label: 'Read Only', description: 'Read and analyze without writes' },
  { value: 'ask', label: 'Ask', description: 'Ask before workspace writes and commands' },
  { value: 'auto', label: 'Auto', description: 'Run in the workspace without prompting' },
  { value: 'fullAccess', label: 'Full Access', description: 'Disable sandboxing for externally isolated environments' },
];

interface FixedPopoverPosition {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

function calculatePopoverPosition(trigger: HTMLElement, menuWidth: number): FixedPopoverPosition {
  const rect = trigger.getBoundingClientRect();
  const viewportPadding = 12;
  const left = Math.min(
    Math.max(viewportPadding, rect.right - menuWidth),
    window.innerWidth - menuWidth - viewportPadding,
  );

  return {
    left,
    bottom: Math.max(12, window.innerHeight - rect.top + 8),
    width: menuWidth,
    maxHeight: Math.max(160, rect.top - 16),
  };
}

function ComposerToggleButton({
  icon: Icon,
  label,
  pressed,
  onClick,
  testId,
  compact = false,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  pressed: boolean;
  onClick: () => void;
  testId?: string;
  compact?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      title={title}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors',
        pressed
          ? 'border-(--accent)/50 bg-(--accent)/10 text-(--accent)'
          : 'border-dashed border-(--divider) bg-transparent text-(--text-tertiary)',
        'hover:border-solid hover:border-(--accent)/40 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
        compact && 'px-2',
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className={compact ? 'max-w-[68px] truncate' : 'whitespace-nowrap'}>
        {label}
      </span>
    </button>
  );
}

function ComposerControlDropdown({
  icon: Icon,
  label,
  children,
  testId,
  compact = false,
  labelClassName,
  truncateLabel = true,
  menuWidth = 280,
  disabled = false,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: (close: () => void) => React.ReactNode;
  testId?: string;
  compact?: boolean;
  labelClassName?: string;
  truncateLabel?: boolean;
  menuWidth?: number;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const calculatePosition = useCallback(
    (trigger: HTMLElement) => calculatePopoverPosition(trigger, menuWidth),
    [menuWidth],
  );
  const { position, updatePosition } = useAnchoredPopover({
    isOpen: open,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef: menuRef,
    calculatePosition,
  });

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (disabled) {
            return;
          }
          if (!open) {
            updatePosition();
          }
          setOpen((value) => !value);
        }}
        disabled={disabled}
        data-testid={testId}
        title={title}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors',
          'border-(--divider) bg-(--input-bg) text-(--text-secondary)',
          'hover:border-(--accent)/40 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
          open && 'border-(--accent)/40 bg-(--sidebar-hover) text-(--text-primary)',
          disabled && 'cursor-not-allowed opacity-60 hover:border-(--divider) hover:bg-(--input-bg) hover:text-(--text-secondary)',
        )}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className={cn(
          truncateLabel ? 'truncate' : 'whitespace-nowrap',
          labelClassName ?? (compact ? 'max-w-[68px]' : 'max-w-[110px]'),
        )}>
          {label}
        </span>
        <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {!disabled && open && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          data-testid={testId ? `${testId}-menu` : undefined}
          data-side="top"
          className="fixed z-[10001] overflow-y-auto rounded-lg border border-(--chat-header-border) bg-(--chat-header-bg) py-1 shadow-lg"
          style={{
            left: position.left,
            bottom: position.bottom,
            width: position.width,
            maxHeight: Math.min(position.maxHeight, 320),
          }}
        >
          {children(close)}
        </div>,
        document.body
      )}
    </div>
  );
}

interface ComposerSessionControlsProps {
  sessionId: string;
  variant?: 'block' | 'inline';
}

interface ComposerSessionControlsInnerProps {
  sessionId: string;
  variant: 'block' | 'inline';
  session: UnifiedSession & { provider: string };
  providerSessionOptions: {
    data: ProviderSessionOptions | null;
    isLoading: boolean;
  };
  initialSessionMode: ProviderSessionMode;
  initialAccessMode: ProviderSessionAccessMode;
  initialModel: string;
  initialReasoningEffort: string | null;
}

function resolveReasoningEffort(
  sessionOptions: ProviderSessionOptions | null,
  selectedModelOption: ProviderModelOption | null,
  requestedReasoningEffort: string | null,
): string | null {
  if (!sessionOptions?.supportsReasoningEffort) {
    return null;
  }

  const reasoningOptions = selectedModelOption?.supportedReasoningEfforts ?? [];
  if (reasoningOptions.length === 0) {
    return requestedReasoningEffort;
  }

  const isSupported = requestedReasoningEffort
    ? reasoningOptions.some((option) => option.value === requestedReasoningEffort)
    : false;

  if (isSupported) {
    return requestedReasoningEffort;
  }

  return selectedModelOption?.defaultReasoningEffort ?? reasoningOptions[0]?.value ?? null;
}

function resolveReasoningLabel(
  reasoningEffort: string | null,
  reasoningOptions: ProviderModelOption['supportedReasoningEfforts'],
  fallbackLabel: string,
): string {
  return reasoningOptions.find((option) => option.value === reasoningEffort)?.value
    ?? reasoningEffort
    ?? fallbackLabel;
}

function isCodexProvider(providerId: string): boolean {
  return providerId === 'codex';
}

function getDefaultWorkAccess(providerId: string): ProviderSessionAccessMode {
  return isCodexProvider(providerId) ? 'ask' : 'default';
}

function getAccessOptions(
  providerId: string,
  sessionOptions: ProviderSessionOptions | null,
): ProviderAccessOption[] {
  if (sessionOptions?.accessOptions?.length) {
    return sessionOptions.accessOptions;
  }

  return isCodexProvider(providerId)
    ? FALLBACK_CODEX_ACCESS_OPTIONS
    : FALLBACK_CLAUDE_ACCESS_OPTIONS;
}

function resolveAccessLabel(
  accessMode: ProviderSessionAccessMode,
  options: ProviderAccessOption[],
): string {
  return options.find((option) => option.value === accessMode)?.label ?? accessMode;
}

function buildRuntimeControls(
  providerId: string,
  sessionMode: ProviderSessionMode,
  accessMode: ProviderSessionAccessMode,
): ProviderRuntimeControls & { permissionMode?: PermissionMode } {
  const defaults = { sessionMode, accessMode };
  const permissionMode = resolveProviderPermissionMode(providerId, defaults);

  return {
    sessionMode,
    accessMode,
    ...(permissionMode && { permissionMode }),
    ...resolveProviderRuntimeControls(providerId, defaults),
  };
}

function ComposerSessionControlsInner({
  sessionId,
  variant,
  session,
  providerSessionOptions,
  initialSessionMode,
  initialAccessMode,
  initialModel,
  initialReasoningEffort,
}: ComposerSessionControlsInnerProps) {
  const { t } = useI18n();
  const [sessionMode, setSessionMode] = useState<ProviderSessionMode>(initialSessionMode);
  const [accessMode, setAccessMode] = useState<ProviderSessionAccessMode>(initialAccessMode);
  const [model, setModel] = useState(initialModel);
  const [requestedReasoningEffort, setRequestedReasoningEffort] = useState<string | null>(initialReasoningEffort);

  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const providerIdForSticky = session.provider;

  const sessionOptions = providerSessionOptions.data;
  const selectedModelOption = sessionOptions?.modelOptions.find((option) => option.value === model) ?? null;
  const reasoningOptions = selectedModelOption?.supportedReasoningEfforts ?? [];
  const reasoningEffort = resolveReasoningEffort(
    sessionOptions,
    selectedModelOption,
    requestedReasoningEffort,
  );

  const persistSessionControls = (
    nextSessionMode: ProviderSessionMode,
    nextAccessMode: ProviderSessionAccessMode,
  ) => {
    const runtimeControls = buildRuntimeControls(providerIdForSticky, nextSessionMode, nextAccessMode);

    void updateSettings({
      ...buildProviderSessionDefaultsUpdate(
        useSettingsStore.getState().settings,
        providerIdForSticky,
        { sessionMode: nextSessionMode, accessMode: nextAccessMode },
      ),
      ...(runtimeControls.permissionMode && providerIdForSticky === 'claude-code'
        ? { defaultPermissionMode: runtimeControls.permissionMode }
        : {}),
    });

    if (session?.isRunning) {
      wsClient.setPermissionMode(sessionId, runtimeControls.permissionMode, runtimeControls);
    }
  };

  const handlePlanToggle = () => {
    const nextSessionMode: ProviderSessionMode = sessionMode === 'plan' ? 'work' : 'plan';
    setSessionMode(nextSessionMode);
    persistSessionControls(nextSessionMode, accessMode);
  };

  const handleAccessModeChange = (nextAccessMode: ProviderSessionAccessMode) => {
    setAccessMode(nextAccessMode);
    persistSessionControls(sessionMode, nextAccessMode);
  };

  const handleModelChange = (nextModel: string) => {
    const nextModelOption = sessionOptions?.modelOptions.find((option) => option.value === nextModel) ?? null;
    const nextReasoningEffort = resolveReasoningEffort(
      sessionOptions,
      nextModelOption,
      reasoningEffort,
    );

    setModel(nextModel);
    setRequestedReasoningEffort(nextReasoningEffort);

    // Sticky persistence — next new session will use this as default, and the
    // first send_message of an unspawned session will pull from here too.
    void updateSettings(
      buildProviderSessionDefaultsUpdate(
        useSettingsStore.getState().settings,
        providerIdForSticky,
        { model: nextModel, reasoningEffort: nextReasoningEffort },
      ),
    );

    if (session?.isRunning) {
      wsClient.setModel(sessionId, nextModel);
      if (sessionOptions?.supportsReasoningEffort && sessionOptions.runtimeEffortChange) {
        wsClient.setReasoningEffort(sessionId, nextReasoningEffort);
      }
    }
  };

  const handleReasoningEffortChange = (nextReasoningEffort: string) => {
    setRequestedReasoningEffort(nextReasoningEffort);

    void updateSettings(
      buildProviderSessionDefaultsUpdate(
        useSettingsStore.getState().settings,
        providerIdForSticky,
        { reasoningEffort: nextReasoningEffort },
      ),
    );

    if (session?.isRunning) {
      wsClient.setReasoningEffort(sessionId, nextReasoningEffort);
    }
  };

  const accessOptions = getAccessOptions(providerIdForSticky, sessionOptions);
  const isAccessLocked = sessionOptions?.planLocksAccess === true && sessionMode === 'plan';
  const accessLabel = isAccessLocked
    ? sessionOptions?.planAccessLabel ?? 'Read-only planning'
    : resolveAccessLabel(accessMode, accessOptions);
  const accessFooterLabel = isCodexProvider(providerIdForSticky)
    ? 'Codex Access maps to approvalPolicy + sandbox.'
    : undefined;
  const modelLabel = selectedModelOption?.label || model || t('settings.model.label');
  const reasoningLabel = resolveReasoningLabel(
    reasoningEffort,
    reasoningOptions,
    t('settings.model.reasoningEffortLabel'),
  );
  const isInline = variant === 'inline';

  return (
    <div
      className={cn(
        'flex items-center gap-1.5',
        isInline
          ? 'shrink-0'
          : 'flex-wrap justify-between gap-2 border-b border-(--divider) bg-(--chat-header-bg) px-3 py-2',
      )}
    >
      <div className={cn('flex items-center gap-1.5', !isInline && 'flex-wrap')}>
        <ComposerSessionRunState
          isInline={isInline}
          isRunning={session.isRunning}
          isStopped={session.status === 'stopped'}
          onStop={() => wsClient.stopSession(sessionId)}
          runningLabel={t('status.running')}
          stoppedLabel={t('status.stopped')}
          stopLabel={t('status.stopProcess')}
        />
      </div>

      <div className={cn('flex items-center gap-1.5', !isInline && 'flex-wrap')}>
        <ComposerToggleButton
          icon={Workflow}
          label="Plan"
          pressed={sessionMode === 'plan'}
          onClick={handlePlanToggle}
          testId="plan-mode-toggle"
          compact={isInline}
          title={sessionMode === 'plan' ? 'Plan mode is on' : 'Plan before implementation'}
        />

        <ComposerControlDropdown
          icon={Shield}
          label={accessLabel}
          testId="access-mode-selector"
          compact={isInline}
          menuWidth={300}
          disabled={isAccessLocked}
          title={isAccessLocked ? 'Claude Code plan mode uses read-only planning until a plan is approved.' : undefined}
        >
          {(close) => (
            <ComposerSessionControlMenu
              footerLabel={accessFooterLabel}
              options={accessOptions}
              selectedValue={accessMode}
              onSelect={(mode) => {
                handleAccessModeChange(mode as ProviderSessionAccessMode);
                close();
              }}
            />
          )}
        </ComposerControlDropdown>

        <ComposerControlDropdown
          icon={Cpu}
          label={modelLabel}
          testId="model-selector"
          compact={isInline}
          labelClassName="max-w-none"
          truncateLabel={false}
          menuWidth={320}
        >
          {(close) => (
            <ComposerModelMenu
              isLoading={providerSessionOptions.isLoading}
              modelOptions={sessionOptions?.modelOptions ?? []}
              selectedModel={model}
              loadingLabel={t('settings.model.loadingOptions')}
              onSelectModel={(nextModel) => {
                handleModelChange(nextModel);
                close();
              }}
            />
          )}
        </ComposerControlDropdown>

        {sessionOptions?.supportsReasoningEffort && reasoningOptions.length > 0 && (
          sessionOptions.runtimeEffortChange || !session?.isRunning ? (
            <ComposerControlDropdown
              icon={Gauge}
              label={reasoningLabel}
              testId="reasoning-effort-selector"
              compact={isInline}
              menuWidth={260}
            >
              {(close) => (
                <ComposerReasoningEffortMenu
                  options={reasoningOptions}
                  selectedEffort={reasoningEffort}
                  onSelect={(nextReasoningEffort) => {
                    handleReasoningEffortChange(nextReasoningEffort);
                    close();
                  }}
                />
              )}
            </ComposerControlDropdown>
          ) : (
            <ComposerReadonlyReasoningBadge
              label={reasoningLabel}
              tooltip={t('settings.effort.readOnlyTooltip')}
            />
          )
        )}
      </div>
    </div>
  );
}

export function ComposerSessionControls({ sessionId, variant = 'block' }: ComposerSessionControlsProps) {
  const session = useSessionStore((state) => state.getSession(sessionId));
  const settings = useSettingsStore((state) => state.settings);
  const providerId = session?.provider?.trim();
  const providerSessionOptions = useProviderSessionOptions(providerId, settings.agentEnvironment);

  if (!session || !providerId) {
    return null;
  }

  const sessionWithProvider: UnifiedSession & { provider: string } = {
    ...session,
    provider: providerId,
  };
  const providerDefaults = getProviderSessionDefaults(settings, providerId);

  const resetKey = [
    sessionId,
    providerId,
    providerDefaults.sessionMode ?? '',
    providerDefaults.accessMode ?? '',
    providerDefaults.model ?? '',
    providerDefaults.reasoningEffort ?? '',
  ].join('::');

  return (
    <ComposerSessionControlsInner
      key={resetKey}
      sessionId={sessionId}
      variant={variant}
      session={sessionWithProvider}
      providerSessionOptions={providerSessionOptions}
      initialSessionMode={providerDefaults.sessionMode ?? 'work'}
      initialAccessMode={providerDefaults.accessMode ?? getDefaultWorkAccess(providerId)}
      initialModel={providerDefaults.model ?? ''}
      initialReasoningEffort={providerDefaults.reasoningEffort ?? null}
    />
  );
}
