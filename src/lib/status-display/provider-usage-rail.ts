import type {
  ProviderRateLimitsSnapshot,
  RateLimitWindowSnapshot,
} from './types';
import { formatDurationLabel } from './build-status-display';

export type ProviderUsageSeverity = 'normal' | 'warning' | 'danger';

export interface ProviderUsageRailWindow {
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  severity: ProviderUsageSeverity;
}

export interface ProviderUsageRailModel {
  providerId: string;
  shortTerm: ProviderUsageRailWindow | null;
  weekly: ProviderUsageRailWindow | null;
}

function severityFromPercent(percent: number): ProviderUsageSeverity {
  if (percent >= 80) return 'danger';
  if (percent >= 60) return 'warning';
  return 'normal';
}

function toRailWindow(
  window: RateLimitWindowSnapshot | undefined,
): ProviderUsageRailWindow | null {
  if (!window) return null;
  const usedPercent = Math.min(100, Math.max(0, Math.round(window.usedPercent)));
  const durationMins = window.windowDurationMins;
  const isWeekly = durationMins === 10080 || window.key === 'weekly';
  const durationLabel = formatDurationLabel(durationMins);
  return {
    label: isWeekly ? 'Weekly limit' : durationLabel?.detailLabel ?? 'Short-term limit',
    shortLabel: isWeekly ? 'W' : durationLabel?.shortLabel ?? 'Short',
    usedPercent,
    resetsAt: window.resetsAt ?? null,
    severity: severityFromPercent(usedPercent),
  };
}

export function buildProviderUsageRailModel(
  providerId: string,
  snapshot: ProviderRateLimitsSnapshot | null,
): ProviderUsageRailModel {
  const windows = snapshot?.windows ?? [];
  const weekly = windows.find(
    (window) => window.windowDurationMins === 10080 || window.key === 'weekly',
  );
  const shortTerm = windows.find(
    (window) => window !== weekly && (
      window.key === 'session'
      || (window.windowDurationMins != null
        && window.windowDurationMins > 0
        && window.windowDurationMins < 10080)
    ),
  );

  return {
    providerId,
    shortTerm: toRailWindow(shortTerm),
    weekly: toRailWindow(weekly),
  };
}
