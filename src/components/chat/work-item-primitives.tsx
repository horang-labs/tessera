'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type React from 'react';
import { Archive, Check, CircleStop, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkflowStatus } from '@/types/task-entity';

type ItemSurface = 'board' | 'sidebar';
type ItemStatusPlacement = 'corner' | 'leading' | 'inline';

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

export function ItemStatusIndicator({
  hasUnread,
  isAwaitingUser,
  isProcessing,
  isRunning,
  placement,
  surface,
}: {
  hasUnread: boolean;
  isAwaitingUser?: boolean;
  isProcessing: boolean;
  isRunning: boolean;
  placement: ItemStatusPlacement;
  surface: ItemSurface;
}) {
  if (!isProcessing && !isAwaitingUser && !hasUnread && !isRunning) {
    return null;
  }

  const ringClass =
    placement === 'inline'
      ? ''
      : surface === 'board'
        ? 'ring-1 ring-(--board-card-bg)'
        : 'ring-1 ring-(--sidebar-bg)';

  if (isProcessing) {
    return (
      <span
        className={cn(
          getPlacementClassName(placement, true),
          ringClass,
          'h-[7px] w-[7px] animate-spin rounded-full border border-(--success) border-t-transparent',
        )}
      />
    );
  }

  if (isAwaitingUser) {
    return (
      <span
        className={cn(
          getPlacementClassName(placement, false),
          ringClass,
          'h-[7px] w-[7px] rounded-full bg-[#facc15] attention-dot-blink',
        )}
      />
    );
  }

  if (hasUnread) {
    return (
      <span
        className={cn(
          getPlacementClassName(placement, false),
          ringClass,
          'h-[6px] w-[6px] rounded-full bg-[#facc15]',
        )}
      />
    );
  }

  return (
    <span
      className={cn(
        getPlacementClassName(placement, false),
        ringClass,
        'h-[5px] w-[5px] rounded-full bg-(--success)',
      )}
    />
  );
}

export function InlineRenameInput({
  className,
  inputRef,
  onCancel,
  onConfirm,
  onValueChange,
  testId,
  value,
}: {
  className?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
  onValueChange: (value: string) => void;
  testId?: string;
  value: string;
}) {
  return (
    <input
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
  testId,
}: {
  className?: string;
  confirmTitle: string;
  idleTitle: string;
  isConfirming: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}) {
  return (
    <button
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
  testId,
  title = 'Stop process',
}: {
  className?: string;
  confirmTitle?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
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
  testId,
}: {
  ariaExpanded?: boolean;
  className?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  size?: 'compact' | 'default';
  buttonRef?: RefObject<HTMLButtonElement | null>;
  testId?: string;
}) {
  return (
    <button
      ref={buttonRef}
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

function getPlacementClassName(
  placement: ItemStatusPlacement,
  isProcessing: boolean,
): string {
  switch (placement) {
    case 'corner':
      // Industry-standard: top-left of the icon (like Gmail/Jira unread dots).
      return 'absolute -top-0.5 -left-0.5';
    case 'leading':
      return cn(
        'absolute top-1/2 z-[1] -translate-y-1/2',
        isProcessing ? 'left-[-3px]' : 'left-[-2px]',
      );
    case 'inline':
      return '';
  }
}
