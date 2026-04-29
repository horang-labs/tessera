'use client';

import { useEffect, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  useCloseOnEscape(() => onOpenChange(false), { enabled: open });

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />

      {/* Content */}
      <div className="relative z-50">{children}</div>
    </div>
  );
}

export interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function DialogContent({ children, className, ...props }: DialogContentProps) {
  return (
    <div
      {...props}
      role="dialog"
      aria-modal="true"
      className={cn(
        'bg-(--sidebar-bg) rounded-lg shadow-2xl p-6 max-w-lg w-full mx-4 border border-(--divider)',
        className
      )}
    >
      {children}
    </div>
  );
}

export interface DialogHeaderProps {
  children: ReactNode;
  onClose?: () => void;
}

export function DialogHeader({ children, onClose }: DialogHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded-md text-(--text-muted) hover:text-(--text-primary) hover:bg-(--sidebar-hover) transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}

export interface DialogTitleProps {
  children: ReactNode;
  className?: string;
}

export function DialogTitle({ children, className }: DialogTitleProps) {
  return (
    <h2 id="dialog-title" className={cn('text-lg font-semibold text-(--text-primary)', className)}>
      {children}
    </h2>
  );
}
