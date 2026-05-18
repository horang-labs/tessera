'use client';

import { useEffect, useRef, useState } from 'react';
import { Pencil, Pause, Play, Target, Trash2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { emitSessionGoalCommandInsert } from '@/lib/chat/session-goal-command-event';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { selectHasActiveAssistantText, selectIsTurnInFlight, useChatStore } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useSessionStore } from '@/stores/session-store';
import { useWebSocket } from '@/hooks/use-websocket';
import {
  applyProviderSessionRuntimeOverrides,
  getProviderSessionRuntimeConfig,
} from '@/lib/settings/provider-defaults';
import type { SessionSpawnConfig } from '@/lib/ws/message-types';
import type { SessionGoalStatus } from '@/types/session-goal';

interface SessionGoalControlProps {
  sessionId: string;
  variant: 'header' | 'composer';
  disabled?: boolean;
  onInsertCommand?: () => void;
}

const STATUS_CLASS: Record<SessionGoalStatus, string> = {
  active: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-300',
  paused: 'border-amber-400/35 bg-amber-400/10 text-amber-300',
  budgetLimited: 'border-sky-400/35 bg-sky-400/10 text-sky-300',
  complete: 'border-(--divider) bg-(--sidebar-hover) text-(--text-secondary)',
};

function getGoalStatusLabel(
  status: SessionGoalStatus,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  switch (status) {
    case 'active':
      return t('goal.status.active');
    case 'paused':
      return t('goal.status.paused');
    case 'budgetLimited':
      return t('goal.status.budgetLimited');
    case 'complete':
      return t('goal.status.complete');
  }
}

function formatGoalMetric(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatGoalDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

export function SessionGoalControl({
  sessionId,
  variant,
  disabled = false,
  onInsertCommand,
}: SessionGoalControlProps) {
  const { t } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const session = useSessionStore((state) => state.getSession(sessionId));
  const isTurnInFlight = useChatStore(selectIsTurnInFlight(sessionId));
  const hasActiveAssistantText = useChatStore(selectHasActiveAssistantText(sessionId));
  const { setSessionGoal, clearSessionGoal } = useWebSocket();
  const goal = session?.goal ?? null;
  const isCodex = session?.provider?.trim() === 'codex';
  const isReadOnly = Boolean(session?.isReadOnly || session?.archived);
  const isDisabled = disabled || isReadOnly;
  const isGoalRunning = Boolean(goal?.status === 'active' && (isTurnInFlight || hasActiveAssistantText));

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  if (!isCodex) {
    return null;
  }

  const statusLabel = goal ? getGoalStatusLabel(goal.status, t) : t('goal.notSet');
  const runtimeLabel = isGoalRunning ? ` · ${t('status.running')}` : '';
  const tooltip = goal ? `${statusLabel}${runtimeLabel}: ${goal.objective}` : t('goal.start');
  const label = variant === 'header'
    ? goal
      ? `Goal ${statusLabel}${runtimeLabel}: ${goal.objective}`
      : t('goal.notSet')
    : t('goal.start');

  const buildSpawnConfig = (): SessionSpawnConfig | undefined => {
    if (session?.isRunning) return undefined;

    const providerId = session?.provider?.trim();
    if (!providerId) return undefined;

    const { settings } = useSettingsStore.getState();
    return applyProviderSessionRuntimeOverrides(
      getProviderSessionRuntimeConfig(settings, providerId),
      session,
      providerId,
    );
  };

  const handleClick = () => {
    if (variant === 'header' && goal) {
      setIsOpen((open) => !open);
      return;
    }

    if (onInsertCommand) {
      onInsertCommand();
      return;
    }
    emitSessionGoalCommandInsert(sessionId);
  };

  return (
    <div ref={popoverRef} className="relative min-w-0 shrink-0">
      <Tooltip content={tooltip} side="top" delay={250} wrapperClassName="min-w-0">
        <button
          type="button"
          onClick={handleClick}
          disabled={isDisabled}
          className={cn(
            'inline-flex shrink-0 items-center justify-center gap-1 rounded-md border font-medium leading-none transition-colors',
            variant === 'header'
              ? 'h-5 max-w-[min(24rem,36vw)] px-1.5 text-[10px]'
              : 'h-7 px-2 text-[11px]',
            goal ? STATUS_CLASS[goal.status] : 'border-(--divider) bg-(--chat-header-bg) text-(--text-secondary)',
            isGoalRunning && 'ring-1 ring-emerald-300/25',
            !isDisabled && 'hover:border-(--accent)/35 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
            isDisabled && 'cursor-not-allowed opacity-50',
          )}
          aria-label={tooltip}
          aria-expanded={variant === 'header' && goal ? isOpen : undefined}
          title={tooltip}
          data-testid={variant === 'header' ? 'session-goal-header-trigger' : 'session-goal-composer-trigger'}
        >
          <Target className={variant === 'header' ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5 shrink-0'} />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </Tooltip>

      {variant === 'header' && goal && isOpen && (
        <div
          className={cn(
            'absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1rem))] rounded-lg border p-3 shadow-xl',
            'border-(--divider) bg-[var(--popover-bg,var(--chat-header-bg))] text-(--text-primary)',
          )}
          data-testid="session-goal-popover"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', isGoalRunning ? 'animate-pulse bg-emerald-300' : 'bg-(--text-muted)')} />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">
                  {statusLabel}{runtimeLabel}
                </div>
                <div className="mt-0.5 text-[11px] text-(--text-muted)">
                  {formatGoalDuration(goal.timeUsedSeconds)} · {t('goal.tokensUsed', { value: formatGoalMetric(goal.tokensUsed) })}
                </div>
              </div>
            </div>
          </div>

          <div className="mb-3 max-h-28 overflow-y-auto rounded-md border border-(--divider) bg-(--input-bg) px-2.5 py-2 text-xs leading-5 text-(--text-secondary)">
            {goal.objective}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                emitSessionGoalCommandInsert(sessionId);
                setIsOpen(false);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-(--divider) px-2 text-[11px] text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
            >
              <Pencil className="h-3 w-3" />
              {t('goal.edit')}
            </button>

            {goal.status === 'active' ? (
              <button
                type="button"
                onClick={() => {
                  setSessionGoal(sessionId, { status: 'paused' }, buildSpawnConfig());
                  setIsOpen(false);
                }}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-(--divider) px-2 text-[11px] text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              >
                <Pause className="h-3 w-3" />
                {t('goal.pause')}
              </button>
            ) : goal.status === 'paused' ? (
              <button
                type="button"
                onClick={() => {
                  setSessionGoal(sessionId, { status: 'active' }, buildSpawnConfig());
                  setIsOpen(false);
                }}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-(--divider) px-2 text-[11px] text-(--text-secondary) hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
              >
                <Play className="h-3 w-3" />
                {t('goal.resume')}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => {
                clearSessionGoal(sessionId, buildSpawnConfig());
                setIsOpen(false);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-(--divider) px-2 text-[11px] text-(--status-error-text) hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]"
            >
              <Trash2 className="h-3 w-3" />
              {t('goal.clear')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
