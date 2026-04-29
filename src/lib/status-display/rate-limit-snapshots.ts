import type { RateLimitData } from '@/lib/rate-limit/fetcher';
import type { ProviderRateLimitsSnapshot } from './types';

function epochToIso(resetsAt: number | null | undefined): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  const millis = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt;
  return new Date(millis).toISOString();
}

export function buildClaudeRateLimitSnapshot(data: RateLimitData): ProviderRateLimitsSnapshot {
  return {
    providerId: 'claude-code',
    windows: [
      {
        key: 'session',
        usedPercent: data.fiveHour.utilization,
        resetsAt: data.fiveHour.resetsAt || null,
        windowDurationMins: 300,
      },
      {
        key: 'weekly',
        usedPercent: data.sevenDay.utilization,
        resetsAt: data.sevenDay.resetsAt || null,
        windowDurationMins: 10080,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
}

export function buildCodexRateLimitSnapshot(
  snapshot: CodexRateLimitSnapshot | null | undefined,
): ProviderRateLimitsSnapshot {
  const windows = [];

  if (snapshot?.primary) {
    windows.push({
      key: 'primary',
      usedPercent: snapshot.primary.usedPercent ?? 0,
      resetsAt: epochToIso(snapshot.primary.resetsAt),
      windowDurationMins: snapshot.primary.windowDurationMins ?? null,
    });
  }

  if (snapshot?.secondary) {
    windows.push({
      key: 'secondary',
      usedPercent: snapshot.secondary.usedPercent ?? 0,
      resetsAt: epochToIso(snapshot.secondary.resetsAt),
      windowDurationMins: snapshot.secondary.windowDurationMins ?? null,
    });
  }

  return {
    providerId: 'codex',
    windows,
    limitId: snapshot?.limitId ?? null,
    limitName: snapshot?.limitName ?? null,
    planType: snapshot?.planType ?? null,
    updatedAt: new Date().toISOString(),
  };
}
