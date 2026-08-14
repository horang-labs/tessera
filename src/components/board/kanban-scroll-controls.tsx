'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

const SCROLL_CONTROL_EPSILON = 1;
const SCROLL_CONTROL_STEP_FALLBACK = 280;
const SCROLL_THUMB_MIN_WIDTH_PX = 36;

interface ScrollControlMetrics {
  clientWidth: number;
  maxScrollLeft: number;
  scrollLeft: number;
  scrollWidth: number;
}

const EMPTY_SCROLL_CONTROL_METRICS: ScrollControlMetrics = {
  clientWidth: 0,
  maxScrollLeft: 0,
  scrollLeft: 0,
  scrollWidth: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface KanbanScrollControlsProps {
  scrollAreaId: string;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
}

export function KanbanScrollControls({ scrollAreaId, scrollAreaRef }: KanbanScrollControlsProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const metricsFrameRef = useRef<number | null>(null);
  const dragStateRef = useRef<{
    maxScrollLeft: number;
    scrollableTrackWidth: number;
    startScrollLeft: number;
    startX: number;
  } | null>(null);
  const [metrics, setMetrics] = useState<ScrollControlMetrics>(EMPTY_SCROLL_CONTROL_METRICS);

  const updateMetrics = useCallback(function updateMetrics() {
    const scrollArea = scrollAreaRef.current;
    const next = scrollArea
      ? {
          clientWidth: scrollArea.clientWidth,
          maxScrollLeft: Math.max(0, scrollArea.scrollWidth - scrollArea.clientWidth),
          scrollLeft: scrollArea.scrollLeft,
          scrollWidth: scrollArea.scrollWidth,
        }
      : EMPTY_SCROLL_CONTROL_METRICS;

    setMetrics((current) => {
      if (
        current.clientWidth === next.clientWidth &&
        current.maxScrollLeft === next.maxScrollLeft &&
        current.scrollLeft === next.scrollLeft &&
        current.scrollWidth === next.scrollWidth
      ) {
        return current;
      }
      return next;
    });
  }, [scrollAreaRef]);

  const scheduleMetricsUpdate = useCallback(function scheduleMetricsUpdate() {
    if (metricsFrameRef.current !== null) return;
    metricsFrameRef.current = requestAnimationFrame(() => {
      metricsFrameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  useEffect(function syncScrollControls() {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    scheduleMetricsUpdate();
    scrollArea.addEventListener('scroll', scheduleMetricsUpdate, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMetricsUpdate);
    resizeObserver?.observe(scrollArea);
    if (scrollArea.firstElementChild instanceof HTMLElement) {
      resizeObserver?.observe(scrollArea.firstElementChild);
    }

    return () => {
      if (metricsFrameRef.current !== null) {
        cancelAnimationFrame(metricsFrameRef.current);
        metricsFrameRef.current = null;
      }
      scrollArea.removeEventListener('scroll', scheduleMetricsUpdate);
      resizeObserver?.disconnect();
    };
  }, [scheduleMetricsUpdate, scrollAreaRef, updateMetrics]);

  const setScrollLeft = useCallback(function setScrollLeft(
    scrollLeft: number,
    behavior: ScrollBehavior = 'auto',
  ) {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    const maxScrollLeft = Math.max(0, scrollArea.scrollWidth - scrollArea.clientWidth);
    scrollArea.scrollTo({
      left: clamp(scrollLeft, 0, maxScrollLeft),
      behavior,
    });
  }, [scrollAreaRef]);

  const scrollByStep = useCallback(function scrollByStep(direction: -1 | 1) {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    const column = scrollArea.querySelector<HTMLElement>('[data-testid="kanban-column"]');
    const step = column ? column.offsetWidth + 12 : SCROLL_CONTROL_STEP_FALLBACK;
    scrollArea.scrollBy({ left: direction * step, behavior: 'smooth' });
  }, [scrollAreaRef]);

  const getThumbWidthPx = useCallback(function getThumbWidthPx(trackWidth: number) {
    if (metrics.scrollWidth <= 0) return trackWidth;
    return clamp(
      (metrics.clientWidth / metrics.scrollWidth) * trackWidth,
      SCROLL_THUMB_MIN_WIDTH_PX,
      trackWidth,
    );
  }, [metrics.clientWidth, metrics.scrollWidth]);

  const handleTrackPointerDown = useCallback(function handleTrackPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (metrics.maxScrollLeft <= SCROLL_CONTROL_EPSILON) return;
    const track = trackRef.current;
    if (!track) return;

    const rect = track.getBoundingClientRect();
    const thumbWidth = getThumbWidthPx(rect.width);
    const targetX = event.clientX - rect.left - thumbWidth / 2;
    const targetRatio = clamp(targetX / Math.max(1, rect.width - thumbWidth), 0, 1);
    setScrollLeft(targetRatio * metrics.maxScrollLeft, 'smooth');
  }, [getThumbWidthPx, metrics.maxScrollLeft, setScrollLeft]);

  const handleThumbPointerDown = useCallback(function handleThumbPointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (metrics.maxScrollLeft <= SCROLL_CONTROL_EPSILON) return;
    const track = trackRef.current;
    if (!track) return;

    event.preventDefault();
    event.stopPropagation();

    const thumbWidth = getThumbWidthPx(track.clientWidth);
    dragStateRef.current = {
      maxScrollLeft: metrics.maxScrollLeft,
      scrollableTrackWidth: Math.max(1, track.clientWidth - thumbWidth),
      startScrollLeft: metrics.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [getThumbWidthPx, metrics.maxScrollLeft, metrics.scrollLeft]);

  const handleThumbPointerMove = useCallback(function handleThumbPointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    event.preventDefault();

    const deltaX = event.clientX - dragState.startX;
    const scrollDelta =
      (deltaX / dragState.scrollableTrackWidth) * dragState.maxScrollLeft;
    setScrollLeft(dragState.startScrollLeft + scrollDelta);
  }, [setScrollLeft]);

  const handleThumbPointerEnd = useCallback(function handleThumbPointerEnd(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scheduleMetricsUpdate();
  }, [scheduleMetricsUpdate]);

  const handleTrackKeyDown = useCallback(function handleTrackKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (metrics.maxScrollLeft <= SCROLL_CONTROL_EPSILON) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      scrollByStep(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      scrollByStep(1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setScrollLeft(0, 'smooth');
    } else if (event.key === 'End') {
      event.preventDefault();
      setScrollLeft(metrics.maxScrollLeft, 'smooth');
    }
  }, [metrics.maxScrollLeft, scrollByStep, setScrollLeft]);

  const canScroll = metrics.maxScrollLeft > SCROLL_CONTROL_EPSILON;
  if (!canScroll) return null;

  const thumbWidthPercent = metrics.scrollWidth > 0
    ? clamp((metrics.clientWidth / metrics.scrollWidth) * 100, 8, 100)
    : 100;
  const thumbLeftPercent =
    (metrics.scrollLeft / Math.max(1, metrics.maxScrollLeft)) * (100 - thumbWidthPercent);
  const atStart = metrics.scrollLeft <= SCROLL_CONTROL_EPSILON;
  const atEnd = metrics.maxScrollLeft - metrics.scrollLeft <= SCROLL_CONTROL_EPSILON;

  return (
    <div
      className="shrink-0 border-t border-(--divider) bg-(--board-bg) px-4 py-2"
      data-testid="kanban-scroll-controls"
    >
      <div className="flex items-center gap-2">
        <button
          {...telemetryClickAttributes('board.scroll.previous', 'workspace_board')}
          type="button"
          aria-label="Scroll kanban board left"
          title="Scroll left"
          disabled={atStart}
          onClick={() => scrollByStep(-1)}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-(--divider)',
            'bg-(--sidebar-bg) text-(--text-muted) transition-colors',
            'hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
            'focus:outline-none focus:ring-2 focus:ring-(--accent)/40',
            'disabled:cursor-default disabled:opacity-35 disabled:hover:bg-(--sidebar-bg) disabled:hover:text-(--text-muted)',
          )}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        <div
          ref={trackRef}
          role="scrollbar"
          aria-label="Kanban horizontal scroll"
          aria-controls={scrollAreaId}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(metrics.maxScrollLeft)}
          aria-valuenow={Math.round(metrics.scrollLeft)}
          tabIndex={0}
          onKeyDown={handleTrackKeyDown}
          onPointerDown={handleTrackPointerDown}
          className={cn(
            'relative h-6 min-w-0 flex-1 cursor-pointer rounded-md',
            'focus:outline-none focus:ring-2 focus:ring-(--accent)/40',
          )}
          data-testid="kanban-scroll-track"
        >
          <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[color-mix(in_srgb,var(--divider)_72%,transparent)]" />
          <div
            className={cn(
              'absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full',
              'bg-(--scrollbar-thumb) shadow-sm transition-colors',
              'hover:bg-(--accent) active:bg-(--accent)',
              'cursor-grab active:cursor-grabbing',
            )}
            style={{
              left: `${thumbLeftPercent}%`,
              width: `${thumbWidthPercent}%`,
            }}
            onPointerDown={handleThumbPointerDown}
            onPointerMove={handleThumbPointerMove}
            onPointerUp={handleThumbPointerEnd}
            onPointerCancel={handleThumbPointerEnd}
            data-testid="kanban-scroll-thumb"
          />
        </div>

        <button
          {...telemetryClickAttributes('board.scroll.next', 'workspace_board')}
          type="button"
          aria-label="Scroll kanban board right"
          title="Scroll right"
          disabled={atEnd}
          onClick={() => scrollByStep(1)}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-(--divider)',
            'bg-(--sidebar-bg) text-(--text-muted) transition-colors',
            'hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
            'focus:outline-none focus:ring-2 focus:ring-(--accent)/40',
            'disabled:cursor-default disabled:opacity-35 disabled:hover:bg-(--sidebar-bg) disabled:hover:text-(--text-muted)',
          )}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
