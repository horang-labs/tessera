'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getTerminalScrollbarGeometry,
  type TerminalScrollMetrics,
} from '@/lib/terminal/terminal-scrollbar-geometry';

interface TerminalScrollbarProps {
  metrics: TerminalScrollMetrics;
}

/**
 * Persistent, non-interactive xterm scroll indicator.
 *
 * macOS hides Chromium's native overlay scrollbar at idle. Keeping this as a
 * sibling of the xterm host reserves a real gutter and avoids covering terminal
 * cells while still leaving all wheel, keyboard, and selection input to xterm.
 */
export function TerminalScrollbar({ metrics }: TerminalScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackHeight, setTrackHeight] = useState(0);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const measure = () => setTrackHeight(track.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(
    () => getTerminalScrollbarGeometry(metrics, trackHeight),
    [metrics, trackHeight],
  );

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-testid="terminal-scrollbar"
      className="pointer-events-none relative h-full w-2 shrink-0 overflow-hidden rounded-full bg-(--terminal-scrollbar-track)"
    >
      <div
        data-testid="terminal-scrollbar-thumb"
        className="absolute inset-x-0 top-0 rounded-full bg-(--terminal-scrollbar-thumb)"
        style={{
          height: geometry.height,
          transform: `translateY(${geometry.top}px)`,
        }}
      />
    </div>
  );
}
