import type { UsageData } from '@/stores/usage-store';
import type { ModelUsageEntry } from '@/lib/ws/message-types';
import type {
  ProviderRateLimitsSnapshot,
  RateLimitWindowSnapshot,
  StatusDisplayLimitWindow,
  StatusDisplayModel,
} from './types';

function severityFromPercent(percent: number): 'normal' | 'warning' | 'danger' {
  if (percent >= 80) return 'danger';
  if (percent >= 50) return 'warning';
  return 'normal';
}

function formatDurationLabel(windowDurationMins: number | null): { label: string; shortLabel: string } | null {
  if (windowDurationMins == null || windowDurationMins <= 0) return null;

  if (windowDurationMins % 10080 === 0) {
    const weeks = windowDurationMins / 10080;
    return { label: `${weeks}w`, shortLabel: `${weeks}w` };
  }
  if (windowDurationMins % 1440 === 0) {
    const days = windowDurationMins / 1440;
    return { label: `${days}d`, shortLabel: `${days}d` };
  }
  if (windowDurationMins % 60 === 0) {
    const hours = windowDurationMins / 60;
    return { label: `${hours}h`, shortLabel: `${hours}h` };
  }
  return { label: `${windowDurationMins}m`, shortLabel: `${windowDurationMins}m` };
}

function titleCaseToken(value: string): string {
  const normalized = value.replace(/[_-]+/g, ' ').trim();
  if (!normalized) return 'Limit';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function resolveLimitLabels(
  providerId: string,
  window: RateLimitWindowSnapshot,
  index: number,
): { label: string; shortLabel: string } {
  if (window.label) {
    return {
      label: window.label,
      shortLabel: window.shortLabel ?? window.label.charAt(0).toUpperCase(),
    };
  }

  if (providerId === 'claude-code') {
    if (window.key === 'session' || window.windowDurationMins === 300) {
      return { label: 'Session', shortLabel: 'S' };
    }
    if (window.key === 'weekly' || window.windowDurationMins === 10080) {
      return { label: 'Weekly', shortLabel: 'W' };
    }
  }

  if (providerId === 'codex') {
    const durationLabel = formatDurationLabel(window.windowDurationMins);
    if (durationLabel) return durationLabel;
    if (window.key === 'primary') return { label: 'Primary', shortLabel: 'P' };
    if (window.key === 'secondary') return { label: 'Secondary', shortLabel: 'S' };
  }

  const durationLabel = formatDurationLabel(window.windowDurationMins);
  if (durationLabel) return durationLabel;
  return {
    label: titleCaseToken(window.key || `limit-${index + 1}`),
    shortLabel: titleCaseToken(window.key || `limit-${index + 1}`).charAt(0),
  };
}

function buildLimitDisplays(
  providerId: string,
  rateLimits: ProviderRateLimitsSnapshot | null,
): StatusDisplayLimitWindow[] {
  if (!rateLimits) return [];

  return rateLimits.windows.map((window, index) => {
    const labels = resolveLimitLabels(providerId, window, index);
    return {
      key: window.key || `window-${index}`,
      label: labels.label,
      shortLabel: labels.shortLabel,
      usedPercent: Math.round(window.usedPercent ?? 0),
      resetsAt: window.resetsAt ?? null,
      severity: severityFromPercent(window.usedPercent ?? 0),
    };
  });
}

function findConfiguredModelUsageEntry(
  entries: ModelUsageEntry[] | undefined,
  configuredModel?: string | null,
): ModelUsageEntry | undefined {
  const model = configuredModel?.trim();
  if (!model || !entries?.length) return undefined;
  return entries.find((entry) => entry.model === model)
    ?? entries.find((entry) => entry.model.startsWith(`${model}[`));
}

export function buildStatusDisplayModel(params: {
  providerId: string;
  usage?: UsageData;
  rateLimits?: ProviderRateLimitsSnapshot | null;
  /**
   * Currently-configured model id from the UI (e.g. "claude-opus-4-7[1m]"
   * or "claude-opus-4-7"). Used to pick the matching modelUsage entry so
   * the displayed context window reflects the user's actual selection —
   * the server-side hint cannot disambiguate between the bracketed and
   * bare variants because Anthropic's assistant.message.model strips the
   * suffix.
   */
  configuredModel?: string | null;
}): StatusDisplayModel {
  const { providerId, usage, rateLimits, configuredModel } = params;

  if (!usage) {
    return {
      providerId,
      usage: null,
      limits: buildLimitDisplays(providerId, rateLimits ?? null),
    };
  }

  // Prefer the modelUsage entry matching the UI-configured model for static
  // model limits only. modelUsage token counters are cumulative across the
  // session, so the context bar numerator must come from per-call usage.
  const matchedEntry = findConfiguredModelUsageEntry(usage.modelUsage, configuredModel);
  const resolvedContextWindow = matchedEntry?.contextWindow ?? usage.contextWindowSize ?? 0;

  const hasContextWindow = resolvedContextWindow > 0;
  const hasPerCallContextUsage = usage.hasPerCallContextUsage ?? false;
  // With a known context window, only per-call snapshots are valid for context
  // percentage. Past sessions without contextWindowSize fall back to input-only
  // token display.
  const hasData = hasContextWindow ? hasPerCallContextUsage : (usage.currentUsage ?? 0) > 0;
  const currentUsage = hasData ? (usage.currentUsage ?? 0) : 0;
  const contextWindow = resolvedContextWindow;
  const usedPercent = hasData && contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((currentUsage / contextWindow) * 100)))
    : 0;

  return {
    providerId,
    usage: {
      hasData,
      hasContextWindow,
      usedPercent,
      contextWindow,
      currentUsage,
      severity: severityFromPercent(usedPercent),
    },
    limits: buildLimitDisplays(providerId, rateLimits ?? null),
  };
}
