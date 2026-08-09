'use client';

import type { AriaRole, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** Shared safe-area shell for phone-only modal sheets. */
export function PhoneBottomSheet({
  ariaLabel,
  backdropTestId,
  children,
  className,
  handleClassName,
  onDismiss,
  role,
  sheetTestId,
}: {
  ariaLabel?: string;
  backdropTestId?: string;
  children: ReactNode;
  className?: string;
  handleClassName?: string;
  onDismiss: () => void;
  role?: AriaRole;
  sheetTestId: string;
}) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end bg-black/60 backdrop-blur-sm"
      data-testid={backdropTestId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div
        role={role}
        aria-modal={role === 'dialog' ? true : undefined}
        aria-label={ariaLabel}
        data-testid={sheetTestId}
        className={cn(
          'max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] w-full overflow-y-auto rounded-t-2xl border border-b-0 border-(--divider) bg-(--sidebar-bg) shadow-2xl',
          className,
        )}
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div
          aria-hidden
          className={cn('mx-auto h-1 w-10 rounded-full bg-(--text-muted)/40', handleClassName)}
        />
        {children}
      </div>
    </div>,
    document.body,
  );
}
