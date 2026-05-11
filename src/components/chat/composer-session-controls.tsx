'use client';

import { useEffect, useState, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Shield, Cpu, Gauge, Square, ChevronDown, Workflow, Zap } from 'lucide-react';
import { tinykeys } from 'tinykeys';
import { useSessionStore } from '@/stores/session-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { useEffectiveShortcut } from '@/hooks/use-effective-shortcut';
import { wsClient } from '@/lib/ws/client';
import type { PermissionMode } from '@/lib/ws/message-types';
import type { ShortcutId } from '@/lib/keyboard/registry';
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
  getProviderSessionDefaultsWithOptions,
  resolveProviderPermissionMode,
  resolveProviderReasoningEffort,
  resolveProviderRuntimeControls,
} from '@/lib/settings/provider-defaults';
import { composeOpenCodeModelId } from '@/lib/cli/providers/opencode/session-config';
import { CODEX_FAST_SERVICE_TIER } from '@/lib/chat/codex-fast-command';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
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

const FALLBACK_OPENCODE_ACCESS_OPTIONS: ProviderAccessOption[] = [
  { value: 'opencodeDefault', label: 'Default', description: 'Use OpenCode config defaults' },
  { value: 'opencodeAskChanges', label: 'Ask Changes', description: 'Ask before shell commands and edits' },
  { value: 'opencodeReadOnly', label: 'Read Only', description: 'Deny changing tools while allowing read/search context' },
  { value: 'opencodeAllowAll', label: 'Allow All', description: 'Allow every OpenCode permission category' },
];

const COMPOSER_CONTROL_DROPDOWN_OPEN_EVENT = 'composer-control-dropdown-open';
const COMPOSER_MENU_ITEM_SELECTOR = '[data-composer-menu-item]:not(:disabled)';

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

function getComposerMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(COMPOSER_MENU_ITEM_SELECTOR));
}

function focusSessionInput(sessionId: string) {
  requestAnimationFrame(() => {
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea[data-session-input]'))
      .find((textarea) => textarea.dataset.sessionInput === sessionId);
    input?.focus();
  });
}

function ComposerToggleButton({
  icon: Icon,
  label,
  pressed,
  onClick,
  testId,
  compact = false,
  title,
  controlId,
  shortcutId,
  shortcutLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  pressed: boolean;
  onClick: () => void;
  testId?: string;
  compact?: boolean;
  title?: string;
  controlId?: string;
  shortcutId?: ShortcutId;
  shortcutLabel?: string;
}) {
  const button = (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      data-composer-control={controlId}
      title={title}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors',
        'composer-quick-access-button',
        pressed
          ? 'border-(--accent)/50 bg-(--accent)/10 text-(--accent)'
          : 'border-dashed border-(--divider) bg-transparent text-(--text-tertiary)',
        'hover:border-solid hover:border-(--accent)/40 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
        compact && 'px-2',
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className={cn('composer-quick-access-label', compact ? 'max-w-[68px] truncate' : 'whitespace-nowrap')}>
        {label}
      </span>
    </button>
  );

  return shortcutId && shortcutLabel
    ? <ShortcutTooltip id={shortcutId} label={shortcutLabel}>{button}</ShortcutTooltip>
    : button;
}

function ComposerFastModeIndicator({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-testid="fast-mode-indicator"
      data-composer-control="service-tier"
      title="Codex fast mode is on"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-(--status-warning-border) bg-(--status-warning-bg) px-2.5 text-[11px] font-medium text-(--status-warning-text)',
        compact && 'px-2',
      )}
    >
      <Zap className="h-3 w-3 shrink-0 fill-current" />
      <span className="composer-quick-access-label whitespace-nowrap">Fast</span>
    </div>
  );
}

function ComposerControlDropdown({
  icon: Icon,
  label,
  children,
  testId,
  controlId,
  compact = false,
  labelClassName,
  truncateLabel = true,
  menuWidth = 280,
  disabled = false,
  title,
  shortcutId,
  shortcutLabel,
  openRequest = 0,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: (close: () => void) => React.ReactNode;
  testId?: string;
  controlId?: string;
  compact?: boolean;
  labelClassName?: string;
  truncateLabel?: boolean;
  menuWidth?: number;
  disabled?: boolean;
  title?: string;
  shortcutId?: ShortcutId;
  shortcutLabel?: string;
  openRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastOpenRequestRef = useRef(openRequest);
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
  const openDropdown = useCallback(() => {
    if (disabled) return;
    updatePosition();
    setOpen(true);
    window.dispatchEvent(new CustomEvent(COMPOSER_CONTROL_DROPDOWN_OPEN_EVENT, {
      detail: containerRef.current,
    }));
  }, [disabled, updatePosition]);

  useEffect(() => {
    const handlePeerOpen = (event: Event) => {
      if ((event as CustomEvent<HTMLElement | null>).detail === containerRef.current) {
        return;
      }
      setOpen(false);
    };

    window.addEventListener(COMPOSER_CONTROL_DROPDOWN_OPEN_EVENT, handlePeerOpen);
    return () => window.removeEventListener(COMPOSER_CONTROL_DROPDOWN_OPEN_EVENT, handlePeerOpen);
  }, []);

  useEffect(() => {
    if (openRequest === lastOpenRequestRef.current) return;
    lastOpenRequestRef.current = openRequest;
    if (openRequest <= 0 || disabled) return;
    const frame = requestAnimationFrame(openDropdown);
    return () => cancelAnimationFrame(frame);
  }, [disabled, openDropdown, openRequest]);

  useEffect(() => {
    if (!open || !position) return;

    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;

      const selectedItem = menu.querySelector<HTMLButtonElement>(
        `${COMPOSER_MENU_ITEM_SELECTOR}[data-selected="true"]`,
      );
      const fallbackItem = menu.querySelector<HTMLButtonElement>(COMPOSER_MENU_ITEM_SELECTOR);
      (selectedItem ?? fallbackItem)?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [open, position]);

  const handleMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;

    const items = getComposerMenuItems(menu);
    if (items.length === 0) return;

    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const focusItem = (index: number) => {
      items[(index + items.length) % items.length]?.focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(currentIndex >= 0 ? currentIndex + 1 : 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(currentIndex >= 0 ? currentIndex - 1 : items.length - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        requestAnimationFrame(() => triggerRef.current?.focus());
        break;
      default:
        break;
    }
  }, [close]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => {
        if (disabled) {
          return;
        }
        if (!open) {
          openDropdown();
          return;
        }
        setOpen(false);
      }}
      disabled={disabled}
      data-testid={testId}
      title={title ?? label}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors',
        'composer-quick-access-button',
        controlId === 'model' && 'w-full min-w-0',
        'border-(--divider) bg-(--input-bg) text-(--text-secondary)',
        'hover:border-(--accent)/40 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
        open && 'border-(--accent)/40 bg-(--sidebar-hover) text-(--text-primary)',
        disabled && 'cursor-not-allowed opacity-60 hover:border-(--divider) hover:bg-(--input-bg) hover:text-(--text-secondary)',
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className={cn(
        'composer-quick-access-label',
        truncateLabel ? 'truncate' : 'whitespace-nowrap',
        labelClassName ?? (compact ? 'max-w-[68px]' : 'max-w-[110px]'),
      )}>
        {label}
      </span>
      <ChevronDown className={cn('composer-quick-access-chevron h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')} />
    </button>
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative',
        controlId === 'model' ? 'min-w-0 shrink' : 'shrink-0',
      )}
      data-composer-control={controlId}
    >
      {shortcutId && shortcutLabel
        ? <ShortcutTooltip id={shortcutId} label={shortcutLabel}>{trigger}</ShortcutTooltip>
        : trigger}

      {!disabled && open && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          data-testid={testId ? `${testId}-menu` : undefined}
          data-side="top"
          role="menu"
          onKeyDown={handleMenuKeyDown}
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
  providerId: string,
  sessionOptions: ProviderSessionOptions | null,
  selectedModelOption: ProviderModelOption | null,
  requestedReasoningEffort: string | null,
): string | null {
  return resolveProviderReasoningEffort(
    providerId,
    sessionOptions,
    selectedModelOption,
    requestedReasoningEffort,
  );
}

function resolveReasoningLabel(
  reasoningEffort: string | null,
  reasoningOptions: ProviderModelOption['supportedReasoningEfforts'],
  fallbackLabel: string,
): string {
  return reasoningOptions.find((option) => option.value === reasoningEffort)?.label
    ?? reasoningEffort
    ?? fallbackLabel;
}

function isCodexProvider(providerId: string): boolean {
  return providerId === 'codex';
}

function isOpenCodeProvider(providerId: string): boolean {
  return providerId === 'opencode';
}

function getDefaultWorkAccess(providerId: string): ProviderSessionAccessMode {
  if (isCodexProvider(providerId)) return 'ask';
  if (isOpenCodeProvider(providerId)) return 'opencodeDefault';
  return 'default';
}

function getDefaultActiveSessionMode(providerId: string): ProviderSessionMode {
  return isOpenCodeProvider(providerId) ? 'build' : 'work';
}

function shouldPersistControlDefaults(session: UnifiedSession): boolean {
  return !session.isRunning && session.status === 'starting';
}

function getAccessOptions(
  providerId: string,
  sessionOptions: ProviderSessionOptions | null,
): ProviderAccessOption[] {
  if (sessionOptions?.accessOptions?.length) {
    return sessionOptions.accessOptions;
  }

  if (isCodexProvider(providerId)) return FALLBACK_CODEX_ACCESS_OPTIONS;
  if (isOpenCodeProvider(providerId)) return FALLBACK_OPENCODE_ACCESS_OPTIONS;
  return FALLBACK_CLAUDE_ACCESS_OPTIONS;
}

function resolveAccessLabel(
  accessMode: ProviderSessionAccessMode,
  options: ProviderAccessOption[],
): string {
  return options.find((option) => option.value === accessMode)?.label ?? accessMode;
}

function resolveModeToggleLabel(): string {
  return 'Plan';
}

function resolveModeToggleTitle(providerId: string, sessionMode: ProviderSessionMode): string {
  if (isOpenCodeProvider(providerId)) {
    return sessionMode === 'plan'
      ? 'OpenCode Plan mode is on. Click to switch to Build.'
      : 'OpenCode Build mode is on. Click to switch to Plan.';
  }

  return sessionMode === 'plan' ? 'Plan mode is on' : 'Plan before implementation';
}

function buildProviderModelControlValue(
  providerId: string,
  model: string,
  reasoningEffort: string | null,
): string {
  if (isOpenCodeProvider(providerId)) {
    return composeOpenCodeModelId(model, reasoningEffort) ?? model;
  }

  return model;
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
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [reasoningOpenRequest, setReasoningOpenRequest] = useState(0);

  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const updateSessionRuntimeConfig = useSessionStore((state) => state.updateSessionRuntimeConfig);
  const modelShortcut = useEffectiveShortcut('open-model-selector');
  const reasoningShortcut = useEffectiveShortcut('open-reasoning-selector');
  const planShortcut = useEffectiveShortcut('toggle-plan-mode');
  const providerIdForSticky = session.provider;

  const sessionOptions = providerSessionOptions.data;
  const selectedModelOption = sessionOptions?.modelOptions.find((option) => option.value === model) ?? null;
  const reasoningOptions = selectedModelOption?.supportedReasoningEfforts ?? [];
  const reasoningEffort = resolveReasoningEffort(
    providerIdForSticky,
    sessionOptions,
    selectedModelOption,
    requestedReasoningEffort,
  );

  const applySessionControls = useCallback((
    nextSessionMode: ProviderSessionMode,
    nextAccessMode: ProviderSessionAccessMode,
  ) => {
    const runtimeControls = buildRuntimeControls(providerIdForSticky, nextSessionMode, nextAccessMode);

    if (shouldPersistControlDefaults(session)) {
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
    } else {
      updateSessionRuntimeConfig(sessionId, {
        sessionMode: nextSessionMode,
        accessMode: nextAccessMode,
      });
    }

    if (session.isRunning) {
      wsClient.setPermissionMode(sessionId, runtimeControls.permissionMode, runtimeControls);
    }
  }, [providerIdForSticky, session, sessionId, updateSessionRuntimeConfig, updateSettings]);

  const handlePlanToggle = useCallback(() => {
    const nextSessionMode: ProviderSessionMode = sessionMode === 'plan'
      ? getDefaultActiveSessionMode(providerIdForSticky)
      : 'plan';
    setSessionMode(nextSessionMode);
    applySessionControls(nextSessionMode, accessMode);
    focusSessionInput(sessionId);
  }, [accessMode, applySessionControls, providerIdForSticky, sessionId, sessionMode]);

  const handleAccessModeChange = (nextAccessMode: ProviderSessionAccessMode) => {
    setAccessMode(nextAccessMode);
    applySessionControls(sessionMode, nextAccessMode);
    focusSessionInput(sessionId);
  };

  const handleModelChange = (nextModel: string) => {
    const nextModelOption = sessionOptions?.modelOptions.find((option) => option.value === nextModel) ?? null;
    const nextReasoningEffort = resolveReasoningEffort(
      providerIdForSticky,
      sessionOptions,
      nextModelOption,
      reasoningEffort,
    );

    setModel(nextModel);
    setRequestedReasoningEffort(nextReasoningEffort);

    if (shouldPersistControlDefaults(session)) {
      // Sticky persistence — next new session will use this as default, and the
      // first send_message of an unspawned session will pull from here too.
      void updateSettings(
        buildProviderSessionDefaultsUpdate(
          useSettingsStore.getState().settings,
          providerIdForSticky,
          { model: nextModel, reasoningEffort: nextReasoningEffort },
        ),
      );
    } else {
      updateSessionRuntimeConfig(sessionId, {
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
      });
    }

    if (session?.isRunning) {
      wsClient.setModel(
        sessionId,
        buildProviderModelControlValue(providerIdForSticky, nextModel, nextReasoningEffort),
      );
      if (
        !isOpenCodeProvider(providerIdForSticky)
        && sessionOptions?.supportsReasoningEffort
        && sessionOptions.runtimeEffortChange
      ) {
        wsClient.setReasoningEffort(sessionId, nextReasoningEffort);
      }
    }
    focusSessionInput(sessionId);
  };

  const handleReasoningEffortChange = (nextReasoningEffort: string) => {
    setRequestedReasoningEffort(nextReasoningEffort);

    if (shouldPersistControlDefaults(session)) {
      void updateSettings(
        buildProviderSessionDefaultsUpdate(
          useSettingsStore.getState().settings,
          providerIdForSticky,
          { reasoningEffort: nextReasoningEffort },
        ),
      );
    } else {
      updateSessionRuntimeConfig(sessionId, { reasoningEffort: nextReasoningEffort });
    }

    if (session?.isRunning) {
      if (isOpenCodeProvider(providerIdForSticky)) {
        wsClient.setModel(
          sessionId,
          buildProviderModelControlValue(providerIdForSticky, model, nextReasoningEffort),
        );
      } else {
        wsClient.setReasoningEffort(sessionId, nextReasoningEffort);
      }
    }
    focusSessionInput(sessionId);
  };

  const accessOptions = getAccessOptions(providerIdForSticky, sessionOptions);
  const isAccessLocked = sessionOptions?.planLocksAccess === true && sessionMode === 'plan';
  const isRuntimeAccessDisabled = session.isRunning && (
    sessionOptions?.runtimeAccessChange === false
    || (isOpenCodeProvider(providerIdForSticky) && sessionOptions?.runtimeAccessChange !== true)
  );
  const isAccessDisabled = isAccessLocked || isRuntimeAccessDisabled;
  const accessDisabledTitle = isAccessLocked
    ? 'Claude Code plan mode uses read-only planning until a plan is approved.'
    : isRuntimeAccessDisabled
      ? 'OpenCode permission presets apply when the session starts. Stop and resume or start a new session to change it.'
      : undefined;
  const accessLabel = isAccessLocked
    ? sessionOptions?.planAccessLabel ?? 'Read-only planning'
    : resolveAccessLabel(accessMode, accessOptions);
  const modeToggleLabel = resolveModeToggleLabel();
  const modeToggleTitle = resolveModeToggleTitle(providerIdForSticky, sessionMode);
  const accessFooterLabel = isCodexProvider(providerIdForSticky)
    ? 'Codex Access maps to approvalPolicy + sandbox.'
    : isOpenCodeProvider(providerIdForSticky)
      ? 'OpenCode permission presets apply when the ACP process starts.'
      : undefined;
  const modelLabel = selectedModelOption?.label || model || t('settings.model.label');
  const reasoningLabel = resolveReasoningLabel(
    reasoningEffort,
    reasoningOptions,
    t('settings.model.reasoningEffortLabel'),
  );
  const isInline = variant === 'inline';
  const isFastModeEnabled = isCodexProvider(providerIdForSticky)
    && session.serviceTier === CODEX_FAST_SERVICE_TIER;
  const canOpenReasoningSelector = Boolean(
    sessionOptions?.supportsReasoningEffort
    && reasoningOptions.length > 0
    && (sessionOptions.runtimeEffortChange || !session?.isRunning),
  );

  useEffect(() => {
    if (!modelShortcut && !reasoningShortcut && !planShortcut) return;

    const isActivePanelSession = () => {
      const panelState = usePanelStore.getState();
      const tabData = selectActiveTab(panelState);
      const panelActiveSessionId = tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
      return sessionId === panelActiveSessionId;
    };

    const bindings: Record<string, (event: KeyboardEvent) => void> = {};
    if (planShortcut) {
      bindings[planShortcut] = (event) => {
        if (!isActivePanelSession()) return;
        event.preventDefault();
        handlePlanToggle();
      };
    }
    if (modelShortcut) {
      bindings[modelShortcut] = (event) => {
        if (!isActivePanelSession()) return;
        event.preventDefault();
        setModelOpenRequest((value) => value + 1);
      };
    }
    if (reasoningShortcut) {
      bindings[reasoningShortcut] = (event) => {
        if (!isActivePanelSession() || !canOpenReasoningSelector) return;
        event.preventDefault();
        setReasoningOpenRequest((value) => value + 1);
      };
    }

    return tinykeys(window, bindings);
  }, [canOpenReasoningSelector, handlePlanToggle, modelShortcut, planShortcut, reasoningShortcut, sessionId]);

  return (
    <div
      className={cn(
        'flex items-center gap-1.5',
        isInline
          ? 'contents'
          : 'flex-wrap justify-between gap-2 border-b border-(--divider) bg-(--chat-header-bg) px-3 py-2',
      )}
    >
      <div className={cn('flex items-center gap-1.5', !isInline && 'flex-wrap', isInline && 'contents')}>
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

      <div className={cn('flex items-center gap-1.5', !isInline && 'flex-wrap', isInline && 'contents')}>
        {isFastModeEnabled && (
          <ComposerFastModeIndicator compact={isInline} />
        )}

        <ComposerToggleButton
          icon={Workflow}
          label={modeToggleLabel}
          pressed={sessionMode === 'plan'}
          onClick={handlePlanToggle}
          testId="plan-mode-toggle"
          compact={isInline}
          controlId="mode"
          title={modeToggleTitle}
          shortcutId="toggle-plan-mode"
          shortcutLabel={t('shortcut.togglePlanMode')}
        />

        <ComposerControlDropdown
          icon={Shield}
          label={accessLabel}
          testId="access-mode-selector"
          controlId="access"
          compact={isInline}
          menuWidth={300}
          disabled={isAccessDisabled}
          title={accessDisabledTitle}
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
          controlId="model"
          compact={isInline}
          labelClassName="min-w-0 max-w-none"
          menuWidth={320}
          shortcutId="open-model-selector"
          shortcutLabel={t('shortcut.openModelSelector')}
          openRequest={modelOpenRequest}
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
              controlId="reasoning"
              compact={isInline}
              menuWidth={260}
              shortcutId="open-reasoning-selector"
              shortcutLabel={t('shortcut.openReasoningSelector')}
              openRequest={reasoningOpenRequest}
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
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const providerId = session?.provider?.trim();
  const providerSessionOptions = useProviderSessionOptions(providerId, settings.agentEnvironment);
  const resolvedProviderId = providerId ?? '';
  const providerDefaults = getProviderSessionDefaults(settings, resolvedProviderId);
  const providerDefaultsWithOptions = getProviderSessionDefaultsWithOptions(
    settings,
    resolvedProviderId,
    providerSessionOptions.data,
  );
  const initialModel = session?.model !== undefined
    ? session.model
    : providerDefaultsWithOptions.model ?? '';
  const initialReasoningEffort = session?.reasoningEffort !== undefined
    ? session.reasoningEffort
    : providerDefaultsWithOptions.reasoningEffort ?? null;
  const initialSessionMode = session?.sessionMode
    ?? providerDefaultsWithOptions.sessionMode
    ?? getDefaultActiveSessionMode(resolvedProviderId);
  const initialAccessMode = session?.accessMode
    ?? providerDefaultsWithOptions.accessMode
    ?? getDefaultWorkAccess(resolvedProviderId);

  useEffect(() => {
    if (
      (resolvedProviderId !== 'codex' && resolvedProviderId !== 'opencode')
      || !providerSessionOptions.data
    ) {
      return;
    }

    const patch: {
      model?: string;
      reasoningEffort?: string | null;
    } = {};

    if (providerDefaultsWithOptions.model && providerDefaults.model !== providerDefaultsWithOptions.model) {
      patch.model = providerDefaultsWithOptions.model;
    }

    if (providerDefaults.reasoningEffort !== providerDefaultsWithOptions.reasoningEffort) {
      patch.reasoningEffort = providerDefaultsWithOptions.reasoningEffort ?? null;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    void updateSettings(
      buildProviderSessionDefaultsUpdate(
        useSettingsStore.getState().settings,
        resolvedProviderId,
        patch,
      ),
    );
  }, [
    resolvedProviderId,
    providerSessionOptions.data,
    providerDefaults.model,
    providerDefaults.reasoningEffort,
    providerDefaultsWithOptions.model,
    providerDefaultsWithOptions.reasoningEffort,
    updateSettings,
  ]);

  if (!session || !providerId) {
    return null;
  }

  const sessionWithProvider: UnifiedSession & { provider: string } = {
    ...session,
    provider: providerId,
  };

  const resetKey = [
    sessionId,
    providerId,
    initialSessionMode,
    initialAccessMode,
    initialModel,
    initialReasoningEffort ?? '',
  ].join('::');

  return (
    <ComposerSessionControlsInner
      key={resetKey}
      sessionId={sessionId}
      variant={variant}
      session={sessionWithProvider}
      providerSessionOptions={providerSessionOptions}
      initialSessionMode={initialSessionMode}
      initialAccessMode={initialAccessMode}
      initialModel={initialModel}
      initialReasoningEffort={initialReasoningEffort}
    />
  );
}
