'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type React from 'react';
import { Archive, Check, CircleStop, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkflowStatus } from '@/types/task-entity';
import type { UnifiedSession } from '@/types/chat';
import {
  telemetryClickAttributes,
  type TelemetryUiControl,
  type TelemetryUiSurface,
} from '@/lib/telemetry/ui-click';

type ItemSurface = 'board' | 'sidebar';
type ItemStatusPlacement = 'corner' | 'leading' | 'inline';
type ItemStatusSize = 'default' | 'lg';

export function getWorktreeIconClass(status: WorkflowStatus): string {
  switch (status) {
    case 'in_progress':
      return 'text-(--worktree-doing)';
    case 'in_review':
      return 'text-(--worktree-review)';
    case 'done':
      return 'text-(--worktree-done)';
    case 'todo':
    default:
      return 'text-(--text-secondary) opacity-80';
  }
}

/**
 * `achieved` / `failed`: the session finished a goal and still shows it (until
 * the user closes it or sets another), so it does not read as a plain turn.
 */
export type ItemGoalIndicator = 'active' | 'paused' | 'achieved' | 'failed' | null;

export function ItemStatusIndicator({
  goal = null,
  hasUnread,
  isAwaitingUser,
  isProcessing,
  isRunning,
  sessionKind,
  placement,
  size = 'default',
  surface,
}: {
  /** A PTY `/goal` in play: replaces the green working spinner with the goal target. */
  goal?: ItemGoalIndicator;
  hasUnread: boolean;
  isAwaitingUser?: boolean;
  isProcessing: boolean;
  isRunning: boolean;
  /** PTY turns outrank stale unread state; GUI keeps its existing priority. */
  sessionKind?: UnifiedSession['kind'];
  placement: ItemStatusPlacement;
  /** 'lg' opts into the enlarged dots the sidebar corner already uses. */
  size?: ItemStatusSize;
  surface: ItemSurface;
}) {
  if (!isProcessing && !isAwaitingUser && !hasUnread && !isRunning && !goal) {
    return null;
  }

  const isEnlarged =
    size === 'lg' || (surface === 'sidebar' && placement === 'corner');

  const ringClass =
    placement === 'inline'
      ? ''
      : surface === 'board'
        ? 'ring-1 ring-(--board-card-bg)'
        : 'ring-1 ring-(--sidebar-bg)';

  const showsProcessing = isProcessing && (sessionKind === 'terminal' || !hasUnread);
  const status = resolveItemStatus({ goal, hasUnread, isAwaitingUser, showsProcessing });

  const statusProps = {
    'data-testid': 'item-status-indicator',
    'data-status': status,
  };

  if (isAwaitingUser) {
    return (
      <span
        {...statusProps}
        className={cn(
          getPlacementClassName(placement, false, isEnlarged),
          ringClass,
          isEnlarged ? 'h-[0.75rem] w-[0.75rem]' : 'h-[7px] w-[7px]',
          'rounded-full bg-[#facc15] attention-dot-blink',
        )}
      />
    );
  }

  if (status === 'goal-ended' || status === 'goal-ended-unread') {
    return (
      <span
        {...statusProps}
        data-goal={goal ?? undefined}
        className={cn(
          getPlacementClassName(placement, false, isEnlarged),
          ringClass,
          isEnlarged ? 'h-[0.8125rem] w-[0.8125rem]' : 'h-[8px] w-[8px]',
          'goal-ended',
          goal === 'failed' && 'goal-ended-failed',
          status === 'goal-ended-unread' && 'goal-ended-unread',
        )}
      />
    );
  }

  if (status === 'goal-processing' || status === 'goal') {
    return (
      <span
        {...statusProps}
        data-goal={goal ?? undefined}
        className={cn(
          getPlacementClassName(placement, status === 'goal-processing', isEnlarged),
          ringClass,
          isEnlarged ? 'h-[0.8125rem] w-[0.8125rem]' : 'h-[8px] w-[8px]',
          status === 'goal-processing'
            ? 'goal-orbit'
            : cn('goal-target', goal === 'paused' && 'goal-target-paused'),
        )}
      />
    );
  }

  if (showsProcessing) {
    return (
      <span
        {...statusProps}
        className={cn(
          getPlacementClassName(placement, true, isEnlarged),
          ringClass,
          isEnlarged ? 'h-[0.75rem] w-[0.75rem]' : 'h-[7px] w-[7px]',
          'animate-spin rounded-full',
          // 'lg' keeps the thicker ring the tab bar has always spun; the small
          // dots stay hairline because 2px would nearly fill a 7px circle.
          size === 'lg'
            ? 'border-2 border-(--success)/30 border-t-(--success)'
            : 'border border-(--success) border-t-transparent',
        )}
      />
    );
  }

  if (hasUnread) {
    return (
      <span
        {...statusProps}
        className={cn(
          getPlacementClassName(placement, false, isEnlarged),
          ringClass,
          isEnlarged ? 'h-[0.6875rem] w-[0.6875rem]' : 'h-[6px] w-[6px]',
          'rounded-full bg-[#facc15]',
        )}
      />
    );
  }

  return (
    <span
      {...statusProps}
      className={cn(
        getPlacementClassName(placement, false, isEnlarged),
        ringClass,
        isEnlarged ? 'h-[0.625rem] w-[0.625rem]' : 'h-[5px] w-[5px]',
        'rounded-full bg-(--success)',
      )}
    />
  );
}

export function WorkflowMessageSquareIcon({
  className,
  fillColor,
  style,
  testId,
}: {
  className?: string;
  fillColor: string;
  style?: React.CSSProperties;
  testId?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
      aria-hidden="true"
      data-testid={testId}
    >
      <path
        d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"
        fill={fillColor}
      />
      <path
        d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function InlineRenameInput({
  className,
  inputRef,
  onCancel,
  onConfirm,
  onValueChange,
  testId,
  telemetrySurface,
  value,
}: {
  className?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  onValueChange: (value: string) => void;
  testId?: string;
  telemetrySurface: Extract<TelemetryUiSurface, 'workspace_list' | 'workspace_board'>;
  value: string;
}) {
  return (
    <input
      {...telemetryClickAttributes('task.rename_input', telemetrySurface)}
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onConfirm();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={onConfirm}
      onClick={(event) => event.stopPropagation()}
      className={className}
      data-testid={testId}
    />
  );
}

export function ArchiveConfirmButton({
  className,
  confirmTitle,
  idleTitle,
  isConfirming,
  onClick,
  telemetryControl,
  telemetrySurface,
  testId,
}: {
  className?: string;
  confirmTitle: string;
  idleTitle: string;
  isConfirming: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  telemetryControl?: TelemetryUiControl;
  telemetrySurface?: TelemetryUiSurface;
  testId?: string;
}) {
  return (
    <button
      {...(telemetryControl && telemetrySurface
        ? telemetryClickAttributes(telemetryControl, telemetrySurface)
        : {})}
      onClick={onClick}
      className={className}
      data-testid={testId}
      aria-label={isConfirming ? 'Confirm archive' : 'Archive'}
      title={isConfirming ? confirmTitle : idleTitle}
    >
      {isConfirming ? <Check className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
    </button>
  );
}

export function StopProcessButton({
  className,
  confirmTitle = 'Click again to stop process',
  onClick,
  telemetryControl,
  telemetrySurface,
  testId,
  title = 'Stop process',
}: {
  className?: string;
  confirmTitle?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  telemetryControl?: TelemetryUiControl;
  telemetrySurface?: TelemetryUiSurface;
  testId?: string;
  title?: string;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const clearConfirmTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const resetConfirm = useCallback(() => {
    clearConfirmTimeout();
    setIsConfirming(false);
  }, [clearConfirmTimeout]);

  const handleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();

    if (isConfirming) {
      resetConfirm();
      onClick(event);
      return;
    }

    clearConfirmTimeout();
    setIsConfirming(true);
    timeoutRef.current = window.setTimeout(() => {
      setIsConfirming(false);
      timeoutRef.current = null;
    }, 3000);
  }, [clearConfirmTimeout, isConfirming, onClick, resetConfirm]);

  useEffect(() => resetConfirm, [resetConfirm]);

  return (
    <button
      type="button"
      {...(telemetryControl && telemetrySurface
        ? telemetryClickAttributes(telemetryControl, telemetrySurface)
        : {})}
      onClick={handleClick}
      className={className}
      data-testid={testId}
      aria-label={isConfirming ? confirmTitle : title}
      title={isConfirming ? confirmTitle : title}
    >
      {isConfirming ? <Check className="h-3.5 w-3.5" /> : <CircleStop className="h-3.5 w-3.5" />}
    </button>
  );
}

export function OverflowMenuButton({
  ariaExpanded,
  className,
  onClick,
  size = 'default',
  buttonRef,
  telemetryControl,
  telemetrySurface,
  testId,
}: {
  ariaExpanded?: boolean;
  className?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  size?: 'compact' | 'default';
  buttonRef?: RefObject<HTMLButtonElement | null>;
  telemetryControl?: TelemetryUiControl;
  telemetrySurface?: TelemetryUiSurface;
  testId?: string;
}) {
  return (
    <button
      ref={buttonRef}
      {...(telemetryControl && telemetrySurface
        ? telemetryClickAttributes(telemetryControl, telemetrySurface)
        : {})}
      onClick={onClick}
      className={cn(
        'rounded transition-all duration-150',
        size === 'compact' ? 'p-0.5' : 'p-1',
        className,
      )}
      aria-label="More options"
      aria-haspopup="menu"
      aria-expanded={ariaExpanded}
      data-testid={testId}
    >
      <MoreHorizontal className="h-3.5 w-3.5" />
    </button>
  );
}

type ItemStatus =
  | 'awaiting-user'
  | 'goal-processing'
  | 'processing'
  | 'goal-ended-unread'
  | 'unread'
  | 'goal-ended'
  | 'goal'
  | 'running';

/**
 * Dot priority. A working goal outranks the plain working spinner (it is the
 * same turn, said more precisely); an idle goal sits below unread so a finished
 * turn still asks to be read.
 */
export function resolveItemStatus({
  goal,
  hasUnread,
  isAwaitingUser,
  showsProcessing,
}: {
  goal: ItemGoalIndicator;
  hasUnread: boolean;
  isAwaitingUser?: boolean;
  showsProcessing: boolean;
}): ItemStatus {
  if (isAwaitingUser) return 'awaiting-user';
  if (showsProcessing) return goal === 'active' ? 'goal-processing' : 'processing';
  const goalEnded = goal === 'achieved' || goal === 'failed';
  // A finished goal keeps its own mark, read or unread, instead of the plain
  // "turn finished" dot.
  if (hasUnread) return goalEnded ? 'goal-ended-unread' : 'unread';
  if (goal) return goalEnded ? 'goal-ended' : 'goal';
  return 'running';
}

function getPlacementClassName(
  placement: ItemStatusPlacement,
  isProcessing: boolean,
  isEnlarged: boolean,
): string {
  switch (placement) {
    case 'corner':
      // Industry-standard: top-left of the icon (like Gmail/Jira unread dots).
      return isEnlarged
        ? 'absolute -top-1 -left-1'
        : 'absolute -top-0.5 -left-0.5';
    case 'leading':
      return cn(
        'absolute top-1/2 z-[1] -translate-y-1/2',
        isProcessing ? 'left-[-3px]' : 'left-[-2px]',
      );
    case 'inline':
      return '';
  }
}
