'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';

export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';

interface PanelDropZoneProps {
  edge: DropEdge;
}

/**
 * Visual overlay showing where a panel split or replace will occur during drag.
 * Edge zones: highlights the corresponding half with a dashed border (split).
 * Center zone: highlights the full panel with a solid border (replace/assign).
 * pointer-events: none — purely presentational.
 */
export const PanelDropZone = memo(function PanelDropZone({ edge }: PanelDropZoneProps) {
  return (
    <div className="absolute inset-0 z-40 pointer-events-none" data-testid="panel-drop-zone">
      <div
        className={cn(
          'absolute rounded-md transition-all duration-150',
          edge === 'center'
            ? 'inset-1 bg-(--accent)/10 border-2 border-solid border-(--accent)'
            : 'bg-(--accent)/15 border-2 border-dashed border-(--accent)',
          edge === 'left' && 'inset-y-1 left-1 w-[calc(50%-4px)]',
          edge === 'right' && 'inset-y-1 right-1 w-[calc(50%-4px)]',
          edge === 'top' && 'inset-x-1 top-1 h-[calc(50%-4px)]',
          edge === 'bottom' && 'inset-x-1 bottom-1 h-[calc(50%-4px)]',
        )}
        data-testid="panel-drop-highlight"
        data-drop-edge={edge}
      />
    </div>
  );
});
