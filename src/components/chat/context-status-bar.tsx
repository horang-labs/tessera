'use client';

import { Fragment } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useUsageStore } from '@/stores/usage-store';
import { useRateLimitStore } from '@/stores/rate-limit-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useContainerWidth } from '@/hooks/use-container-width';
import { buildStatusDisplayModel } from '@/lib/status-display/build-status-display';
import { Tooltip } from '@/components/ui/tooltip';
import type { ModelUsageEntry } from '@/lib/ws/message-types';
import { cn } from '@/lib/utils';

interface ContextStatusBarProps {
  sessionId: string;
  isReadOnly?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function ModelUsageTooltip({
  entries,
  providerId,
}: {
  entries: ModelUsageEntry[];
  providerId: string;
}) {
  // Codex (OpenAI) caches transparently and does not bill cache creation
  // separately, so the breakdown is always 0 — render as "-" to avoid
  // suggesting "no cache activity" when Cache Read shows otherwise.
  const cacheCreateApplies = providerId !== 'codex';

  return (
    <div className="flex flex-col gap-1.5 font-mono tabular-nums text-[11px] leading-tight">
      <table className="border-collapse">
        <thead>
          <tr className="text-zinc-400">
            <th className="text-left pr-3 font-normal">Model</th>
            <th className="text-right pr-3 font-normal">Input</th>
            <th className="text-right pr-3 font-normal">Output</th>
            <th className="text-right pr-3 font-normal">Cache Read</th>
            <th className="text-right pr-3 font-normal">Cache Create</th>
            <th className="text-right pr-3 font-normal">Context</th>
            <th className="text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.model} className="text-zinc-100">
              <td className="text-left pr-3">{entry.model}</td>
              <td className="text-right pr-3">{formatTokens(entry.inputTokens)}</td>
              <td className="text-right pr-3">{formatTokens(entry.outputTokens)}</td>
              <td className="text-right pr-3">{formatTokens(entry.cacheReadInputTokens)}</td>
              <td className="text-right pr-3">
                {cacheCreateApplies ? formatTokens(entry.cacheCreationInputTokens) : '-'}
              </td>
              <td className="text-right pr-3">{entry.contextWindow ? formatTokens(entry.contextWindow) : '-'}</td>
              <td className="text-right">{formatCost(entry.costUSD)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatResetTime(resetsAt: string): string {
  if (!resetsAt) return '--';
  const now = Date.now();
  const reset = new Date(resetsAt).getTime();
  const diffMs = reset - now;
  if (diffMs <= 0) return '0m';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function rateLimitColor(utilization: number): string {
  if (utilization >= 80) return 'text-(--status-error-text)';
  if (utilization >= 50) return 'text-(--status-warning-text)';
  return 'text-zinc-400';
}

export function ContextStatusBar({ sessionId, isReadOnly }: ContextStatusBarProps) {
  const providerId = useSessionStore((s) => s.getSession(sessionId)?.provider?.trim() ?? null);
  const usage = useUsageStore((s) => s.sessionUsage.get(sessionId));
  const rateLimits = useRateLimitStore((s) => providerId ? s.limitsByProvider[providerId] ?? null : null);
  const configuredModel = useSettingsStore((s) =>
    providerId ? s.settings.providerDefaults?.[providerId]?.model?.trim() ?? null : null,
  );
  const { width, ref } = useContainerWidth();

  if (!providerId) {
    return null;
  }

  const display = buildStatusDisplayModel({ providerId, usage, rateLimits, configuredModel });

  // Container-based responsive breakpoints
  const isWide = (width ?? 0) >= 400;
  const isMedium = (width ?? 0) >= 250;

  const usageDisplay = display.usage;
  const hasData = !!usageDisplay?.hasData;
  const hasContextWindow = !!usageDisplay?.hasContextWindow;
  const usedPercent = usageDisplay?.usedPercent ?? 0;
  const contextWindow = usageDisplay?.contextWindow ?? 0;
  const currentUsage = usageDisplay?.currentUsage ?? 0;
  const limitWindows = display.limits;

  const severityText = usageDisplay?.severity === 'danger'
    ? 'text-(--status-error-text)'
    : usageDisplay?.severity === 'warning'
      ? 'text-(--status-warning-text)'
      : 'text-zinc-400';

  const contextBarBg = usageDisplay?.severity === 'danger'
    ? 'bg-red-400'
    : usageDisplay?.severity === 'warning'
      ? 'bg-yellow-400'
      : 'bg-(--accent)';

  const showBar = isMedium && hasContextWindow;
  const dot = <span className="text-zinc-600">·</span>;
  const modelUsageEntries = usage?.modelUsage;
  const hasModelUsage = !!modelUsageEntries && modelUsageEntries.length > 0;

  const usageNumbers = (
    hasContextWindow ? (
      <>
        <span className={severityText}>
          {hasData ? `${Math.round(usedPercent)}%` : '--%'}
        </span>
        <span className="text-zinc-500">
          {hasData
            ? `${formatTokens(currentUsage)}/${formatTokens(contextWindow)}`
            : '----/----'}
        </span>
      </>
    ) : (
      <span className="text-zinc-400">
        {hasData ? `${formatTokens(currentUsage)} tokens` : '---- tokens'}
      </span>
    )
  );

  return (
    <div
      ref={ref}
      className="flex items-center gap-1 mt-1 text-[9px] leading-none select-none font-mono tabular-nums overflow-hidden whitespace-nowrap"
    >
      {/* Context label + bar (live sessions only) */}
      {hasContextWindow && isWide && (
        <span className="text-zinc-500">Context</span>
      )}

      {showBar && (
        <div className={cn(
          'h-[5px] rounded-full bg-zinc-800 overflow-hidden flex shrink-0',
          isWide ? 'w-[120px]' : 'w-[60px]'
        )}>
          <div
            className={cn('h-full transition-all duration-300', contextBarBg)}
            style={{ width: `${Math.min(usedPercent, 100)}%` }}
          />
        </div>
      )}

      {hasModelUsage ? (
        <Tooltip
          side="top"
          delay={150}
          content={<ModelUsageTooltip entries={modelUsageEntries!} providerId={providerId} />}
          className="max-w-none px-3 py-2"
          wrapperClassName="cursor-help inline-flex items-center gap-1"
        >
          {usageNumbers}
        </Tooltip>
      ) : (
        usageNumbers
      )}

      {dot}

      {limitWindows.length > 0 ? (
        limitWindows.map((limit, index) => (
          <Fragment key={limit.key}>
            {index > 0 && dot}
            <span className={rateLimitColor(limit.usedPercent)}>
              {isWide
                ? `${limit.label} ${limit.usedPercent}% ${formatResetTime(limit.resetsAt ?? '')}`
                : `${limit.shortLabel} ${limit.usedPercent}%`}
            </span>
          </Fragment>
        ))
      ) : (
        <span className="text-zinc-600">
          {isWide ? 'Limits --' : 'L --'}
        </span>
      )}
    </div>
  );
}
