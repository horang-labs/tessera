'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface UseAnchoredPopoverOptions<TPosition> {
  isOpen: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  calculatePosition: (trigger: HTMLElement) => TPosition;
}

export function useAnchoredPopover<TPosition>({
  isOpen,
  onClose,
  triggerRef,
  containerRef,
  popoverRef,
  calculatePosition,
}: UseAnchoredPopoverOptions<TPosition>) {
  const [position, setPosition] = useState<TPosition | null>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    setPosition(calculatePosition(trigger));
  }, [calculatePosition, triggerRef]);

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }

      onClose();
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [containerRef, isOpen, onClose, popoverRef, updatePosition]);

  return { position, updatePosition };
}
