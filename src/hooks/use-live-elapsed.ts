'use client';

import { useEffect, useState } from 'react';

export interface UseLiveElapsedOptions {
  isActive: boolean;
  startTime?: string | null;
  intervalMs?: number;
}

export function useLiveElapsed({
  isActive,
  startTime,
  intervalMs = 100,
}: UseLiveElapsedOptions): number {
  const [now, setNow] = useState(() => Date.now());
  const [fallbackStartMs, setFallbackStartMs] = useState<number | null>(null);

  const parsedStartMs = startTime ? new Date(startTime).getTime() : null;
  const hasValidStartTime = parsedStartMs !== null && !Number.isNaN(parsedStartMs);
  const startMs = !isActive
    ? null
    : hasValidStartTime
      ? parsedStartMs
      : fallbackStartMs ?? now;

  useEffect(() => {
    if (!isActive) {
      const frameId = requestAnimationFrame(() => setFallbackStartMs(null));
      return () => cancelAnimationFrame(frameId);
    }

    if (!hasValidStartTime && fallbackStartMs === null) {
      const frameId = requestAnimationFrame(() => setFallbackStartMs(Date.now()));
      return () => cancelAnimationFrame(frameId);
    }

    if (hasValidStartTime && fallbackStartMs !== null) {
      const frameId = requestAnimationFrame(() => setFallbackStartMs(null));
      return () => cancelAnimationFrame(frameId);
    }
  }, [fallbackStartMs, hasValidStartTime, isActive]);

  useEffect(() => {
    if (startMs === null) return;

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, startMs]);

  if (startMs === null) return 0;

  return Math.max(0, now - startMs);
}
