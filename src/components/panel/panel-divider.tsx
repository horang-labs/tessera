// src/components/panel/panel-divider.tsx (Unit 2: 완전 구현)
'use client';

import type React from 'react';
import { cn } from '@/lib/utils';
import { usePanelResize } from '@/hooks/use-panel-resize';

interface PanelDividerProps {
  direction: 'horizontal' | 'vertical';
  initialRatio: number;                          // 현재 분할 비율 (0.0~1.0)
  onResize: (ratio: number) => void;             // 비율 변경 콜백
  containerRef: React.RefObject<HTMLDivElement | null>; // 분할 컨테이너 div ref (flex 부모)
}

export function PanelDivider({
  direction,
  initialRatio,
  onResize,
  containerRef,
}: PanelDividerProps) {
  const isHorizontal = direction === 'horizontal';

  const { isDragging, handleMouseDown } = usePanelResize({
    direction,
    initialRatio,
    minRatio: 0.15,
    maxRatio: 0.85,
    onRatioChange: onResize,
    containerRef,
  });

  return (
    <div
      data-testid="panel-divider"
      data-direction={direction}
      data-dragging={String(isDragging)}
      className={cn(
        'relative z-10 shrink-0 flex items-center justify-center transition-all duration-150',
        isHorizontal
          ? 'w-1 h-full cursor-col-resize'
          : 'w-full h-1 cursor-row-resize',
        isDragging && '[&>div]:bg-(--accent) [&>div]:shadow-[0_0_6px_var(--accent)]',
        !isDragging && 'hover:[&>div]:bg-(--accent) hover:[&>div]:shadow-[0_0_4px_var(--accent)]'
      )}
      onMouseDown={handleMouseDown}
    >
      {/* Visual 1px line centered in the hit area */}
      <div
        className={cn(
          'pointer-events-none transition-all duration-150 bg-(--divider)',
          isHorizontal ? 'w-px h-full' : 'w-full h-px'
        )}
      />
    </div>
  );
}
