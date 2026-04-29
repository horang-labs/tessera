'use client';

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  wrapperClassName?: string;
  delay?: number; // Delay in milliseconds before showing tooltip (default: 0)
  side?: 'top' | 'bottom';
  sideOffset?: number;
}

export function Tooltip({
  content,
  children,
  className,
  wrapperClassName,
  delay = 0,
  side = 'bottom',
  sideOffset = 16,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const mousePos = useRef({ x: 0, y: 0 });

  const handleMouseMove = useCallback(function trackMouse(e: React.MouseEvent) {
    mousePos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseEnter = useCallback(function showTooltip(e: React.MouseEvent) {
    mousePos.current = { x: e.clientX, y: e.clientY };
    const nextPosition = () => ({
      top: side === 'top'
        ? mousePos.current.y - sideOffset
        : mousePos.current.y + sideOffset,
      left: mousePos.current.x,
    });

    if (delay > 0) {
      timeoutRef.current = setTimeout(() => {
        setPosition(nextPosition());
        setIsVisible(true);
      }, delay);
    } else {
      setPosition(nextPosition());
      setIsVisible(true);
    }
  }, [delay, side, sideOffset]);

  const handleMouseLeave = useCallback(function hideTooltip() {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  // Cleanup on unmount
  useEffect(function cleanupTimeout() {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={triggerRef}
      className={cn('relative inline-flex min-w-0', wrapperClassName)}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isVisible && position && createPortal(
        <div
          className={cn(
            'fixed z-[9999] max-w-sm rounded-md bg-(--tooltip-bg) px-3 py-1.5 text-xs text-white shadow-lg pointer-events-none break-words',
            className
          )}
          style={{
            top: position.top,
            left: position.left,
            transform: side === 'top' ? 'translateY(-100%)' : undefined,
          }}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  );
}
