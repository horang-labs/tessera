'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BottomDrawerProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  onResize?: (height: number) => void;
  height?: number;
  minHeight?: number;
  maxHeight?: number;
  closeOnEscape?: boolean;
  className?: string;
  children: ReactNode;
}

export function BottomDrawer({
  icon,
  title,
  subtitle,
  headerActions,
  onClose,
  onResize,
  height = 320,
  minHeight = 160,
  maxHeight = 720,
  closeOnEscape = true,
  className,
  children,
}: BottomDrawerProps) {
  const dragStartRef = useRef<{ y: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (!closeOnEscape) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [closeOnEscape, onClose]);

  function handleMouseDown(e: React.MouseEvent) {
    if (!onResize) return;
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, startHeight: height };

    function handleMove(ev: MouseEvent) {
      if (!dragStartRef.current || !onResize) return;
      const delta = dragStartRef.current.y - ev.clientY;
      const next = Math.max(
        minHeight,
        Math.min(maxHeight, dragStartRef.current.startHeight + delta),
      );
      onResize(next);
    }

    function handleUp() {
      dragStartRef.current = null;
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    }

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }

  return (
    <div
      data-testid="bottom-drawer"
      className={cn(
        'relative flex shrink-0 flex-col border-t-2 border-t-(--accent) bg-(--tool-bg) shadow-[0_-4px_20px_rgba(0,0,0,0.3)]',
        className,
      )}
      style={{ height }}
    >
      {/* Resize handle */}
      {onResize ? (
        <div
          className="absolute inset-x-0 -top-[3px] z-10 h-[6px] cursor-row-resize group"
          onMouseDown={handleMouseDown}
          aria-label="Resize drawer"
          role="separator"
        >
          <div className="mx-auto mt-[2px] h-[2px] w-10 rounded-full bg-(--accent) opacity-0 transition-opacity group-hover:opacity-60" />
        </div>
      ) : null}

      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--tool-border) bg-(--tool-header-hover) px-3 py-2">
        {icon ? <div className="shrink-0 text-(--accent)">{icon}</div> : null}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 truncate text-sm font-medium text-(--text-secondary)">
            {title}
          </div>
          {subtitle ? (
            <div className="shrink-0 text-xs text-(--text-muted)">{subtitle}</div>
          ) : null}
        </div>
        {headerActions}
        <button
          onClick={onClose}
          className="shrink-0 rounded p-1.5 text-(--text-muted) transition-colors hover:bg-(--tool-bg) hover:text-(--text-secondary)"
          aria-label="Close drawer"
          data-testid="bottom-drawer-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
