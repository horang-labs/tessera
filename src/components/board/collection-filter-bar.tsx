'use client';

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Tag, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useBoardStore } from '@/stores/board-store';
import type { Collection } from '@/types/collection';

interface ElectronApiBoardPopout {
  isElectron?: boolean;
  openBoardWindow?: (payload?: {
    projectDir?: string | null;
    collectionFilter?: string | null;
    runningFilter?: boolean;
  }) => Promise<unknown>;
}

function getBoardPopoutApi(): ElectronApiBoardPopout | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronApiBoardPopout }).electronAPI;
}

function isPopoutWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TESSERA_POPOUT__?: boolean }).__TESSERA_POPOUT__);
}

interface CollectionFilterBarProps {
  collections: Collection[];
  activeFilter: string | null; // null = show all
  onFilter: (collectionId: string | null) => void;
  trailingControls?: ReactNode;
}

/**
 * CollectionFilterBar -- horizontal pill-style filter chips.
 * "All" is always the first chip; each collection follows.
 */
export const CollectionFilterBar = memo(function CollectionFilterBar({
  collections,
  activeFilter,
  onFilter,
  trailingControls,
}: CollectionFilterBarProps) {
  const { t } = useI18n();
  const chipsRef = useRef<HTMLDivElement>(null);
  const [isChipScrollerOverflowing, setIsChipScrollerOverflowing] = useState(false);

  const updateChipScrollerOverflow = useCallback(() => {
    const chips = chipsRef.current;
    if (!chips) return;
    setIsChipScrollerOverflowing(chips.scrollWidth > chips.clientWidth + 1);
  }, []);

  useEffect(() => {
    updateChipScrollerOverflow();
    const chips = chipsRef.current;
    if (!chips) return;

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateChipScrollerOverflow);
      return () => window.removeEventListener('resize', updateChipScrollerOverflow);
    }

    const observer = new ResizeObserver(updateChipScrollerOverflow);
    observer.observe(chips);

    for (const child of Array.from(chips.children)) {
      observer.observe(child);
    }

    return () => observer.disconnect();
  }, [collections, updateChipScrollerOverflow]);

  const chipScroller = (
    <div
      ref={chipsRef}
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none"
      data-testid="collection-filter-chips"
    >
      {/* "All" chip */}
      <button
        type="button"
        onClick={() => onFilter(null)}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1 rounded-2xl',
          'text-[0.75rem] font-medium whitespace-nowrap',
          'border cursor-pointer transition-all duration-150 select-none',
          activeFilter === null
            ? 'bg-(--accent) text-white border-(--accent)'
            : 'bg-(--sidebar-hover) text-(--text-muted) border-transparent hover:text-(--text-secondary) hover:bg-(--sidebar-active)',
        )}
        data-testid="collection-filter-all"
      >
        <Tag className="w-3 h-3" />
        <span>All</span>
      </button>

      {/* Collection chips */}
      {collections.map((col) => (
        <button
          type="button"
          key={col.id}
          onClick={() => onFilter(activeFilter === col.id ? null : col.id)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1 rounded-2xl',
            'text-[0.75rem] font-medium whitespace-nowrap',
            'border cursor-pointer transition-all duration-150 select-none',
            activeFilter === col.id
              ? 'bg-(--accent) text-white border-(--accent)'
              : 'bg-(--sidebar-hover) text-(--text-muted) border-transparent hover:text-(--text-secondary) hover:bg-(--sidebar-active)',
          )}
          data-testid={`collection-filter-${col.id}`}
        >
          <Tag className="w-3 h-3" />
          <span>{col.label}</span>
        </button>
      ))}
    </div>
  );

  const electronApi = getBoardPopoutApi();
  const canPopout = Boolean(electronApi?.isElectron && electronApi.openBoardWindow) && !isPopoutWindow();

  const handlePopout = useCallback(() => {
    const {
      selectedProjectDir,
      activeCollectionFilter,
      isKanbanRunningFilterActive,
    } = useBoardStore.getState();
    void electronApi?.openBoardWindow?.({
      projectDir: selectedProjectDir,
      collectionFilter: activeCollectionFilter,
      runningFilter: isKanbanRunningFilterActive,
    });
  }, [electronApi]);

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2 bg-(--board-bg) px-3 py-2"
      data-testid="collection-filter-bar"
    >
      {isChipScrollerOverflowing ? (
        <Tooltip
          content={t('task.board.horizontalScrollHint')}
          delay={350}
          wrapperClassName="flex-1"
        >
          {chipScroller}
        </Tooltip>
      ) : chipScroller}
      {trailingControls}
      {canPopout && (
        <Tooltip content="Open board in new window" delay={350}>
          <button
            type="button"
            onClick={handlePopout}
            className={cn(
              'shrink-0 rounded p-1.5 text-(--text-muted) transition-colors',
              'hover:bg-(--sidebar-hover) hover:text-(--text-primary) cursor-pointer',
            )}
            aria-label="Open board in new window"
            data-testid="board-popout-button"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
        </Tooltip>
      )}
    </div>
  );
});
