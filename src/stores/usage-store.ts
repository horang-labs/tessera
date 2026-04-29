import { create } from 'zustand';
import type { ModelUsageEntry } from '@/lib/ws/message-types';

export interface UsageData {
  // From the most recent result/turn-completed notification.
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindowSize: number; // 0 = unknown (past sessions)
  maxOutputTokens: number;
  durationApiMs: number;
  costUsd: number;
  numTurns: number;
  // Computed
  currentUsage: number;
  usedPercent: number; // 0 when contextWindowSize unknown
  // From per-call context_usage events. Claude Code result/modelUsage values are
  // cumulative, so they should not drive the context bar denominator.
  hasPerCallContextUsage: boolean;
  perCallInputTokens: number;
  perCallCacheCreationTokens: number;
  perCallCacheReadTokens: number;
  // Per-model breakdown from CLI's modelUsage. Used by ContextStatusBar
  // tooltip to show input/output/cache/cost per model. Cumulative across
  // the session (passed through from CLI as-is).
  modelUsage?: ModelUsageEntry[];
}

interface UsageState {
  sessionUsage: Map<string, UsageData>;

  /** Update from result / turn-completed notification. */
  updateUsage: (sessionId: string, raw: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindowSize?: number;
    maxOutputTokens?: number;
    durationApiMs: number;
    costUsd: number;
    numTurns: number;
    modelUsage?: ModelUsageEntry[];
  }) => void;

  /** Update from message_start / tokenUsage.last per-call context snapshots. */
  updateContextUsage: (sessionId: string, raw: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindowSize?: number;
  }) => void;

  clearUsage: (sessionId: string) => void;
}

/**
 * Context window usage = input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens (the three are disjoint in Anthropic API per-call
 * usage). For Codex, cacheCreationTokens is always 0 so the formula still
 * holds with the actual non-cached input + cached input split.
 */
function calcContextPercent(
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  contextWindowSize: number,
): { currentUsage: number; usedPercent: number } {
  const currentUsage = inputTokens + cacheCreationTokens + cacheReadTokens;
  const usedPercent = contextWindowSize > 0
    ? Math.min(100, Math.max(0, Math.round((currentUsage / contextWindowSize) * 100)))
    : 0;
  return { currentUsage, usedPercent };
}

function isValidContextUsage(
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  contextWindowSize: number,
): boolean {
  if (contextWindowSize <= 0) return true;
  return inputTokens + cacheCreationTokens + cacheReadTokens <= contextWindowSize;
}

export const useUsageStore = create<UsageState>((set) => ({
  sessionUsage: new Map(),

  updateUsage: (sessionId, raw) => {
    // Preserve previous contextWindowSize/maxOutputTokens when the new payload
    // doesn't include them (e.g. result for local commands without modelUsage).
    const prevForFallback = useUsageStore.getState().sessionUsage.get(sessionId);
    const contextWindowSize = raw.contextWindowSize || prevForFallback?.contextWindowSize || 0;
    const maxOutputTokens = raw.maxOutputTokens || prevForFallback?.maxOutputTokens || 0;
    const hasPerCallContextUsage = prevForFallback?.hasPerCallContextUsage ?? false;
    const perCallInputTokens = prevForFallback?.perCallInputTokens ?? 0;
    const perCallCacheCreationTokens = prevForFallback?.perCallCacheCreationTokens ?? 0;
    const perCallCacheReadTokens = prevForFallback?.perCallCacheReadTokens ?? 0;
    const displayInputTokens = hasPerCallContextUsage ? perCallInputTokens : raw.inputTokens;
    const displayCacheCreationTokens = hasPerCallContextUsage
      ? perCallCacheCreationTokens
      : raw.cacheCreationTokens;
    const displayCacheReadTokens = hasPerCallContextUsage
      ? perCallCacheReadTokens
      : raw.cacheReadTokens;

    set((state) => {
      const updated = new Map(state.sessionUsage);

      const canUseRawUsageAsFallback = !hasPerCallContextUsage && contextWindowSize <= 0;
      const { currentUsage, usedPercent } = hasPerCallContextUsage || canUseRawUsageAsFallback
        ? calcContextPercent(
            displayInputTokens,
            displayCacheCreationTokens,
            displayCacheReadTokens,
            contextWindowSize,
          )
        : { currentUsage: 0, usedPercent: 0 };

      updated.set(sessionId, {
        ...raw,
        contextWindowSize,
        maxOutputTokens,
        currentUsage,
        usedPercent,
        hasPerCallContextUsage,
        perCallInputTokens,
        perCallCacheCreationTokens,
        perCallCacheReadTokens,
        modelUsage: raw.modelUsage ?? prevForFallback?.modelUsage,
      });
      return { sessionUsage: updated };
    });
  },

  updateContextUsage: (sessionId, raw) => {
    const prevForFallback = useUsageStore.getState().sessionUsage.get(sessionId);
    const contextWindowSize = raw.contextWindowSize || prevForFallback?.contextWindowSize || 0;

    if (!isValidContextUsage(
      raw.inputTokens,
      raw.cacheCreationTokens,
      raw.cacheReadTokens,
      contextWindowSize,
    )) {
      return;
    }

    set((state) => {
      const updated = new Map(state.sessionUsage);
      const { currentUsage, usedPercent } = calcContextPercent(
        raw.inputTokens,
        raw.cacheCreationTokens,
        raw.cacheReadTokens,
        contextWindowSize,
      );

      updated.set(sessionId, {
        inputTokens: prevForFallback?.inputTokens ?? 0,
        outputTokens: prevForFallback?.outputTokens ?? 0,
        cacheReadTokens: prevForFallback?.cacheReadTokens ?? 0,
        cacheCreationTokens: prevForFallback?.cacheCreationTokens ?? 0,
        contextWindowSize,
        maxOutputTokens: prevForFallback?.maxOutputTokens ?? 0,
        durationApiMs: prevForFallback?.durationApiMs ?? 0,
        costUsd: prevForFallback?.costUsd ?? 0,
        numTurns: prevForFallback?.numTurns ?? 0,
        currentUsage,
        usedPercent,
        hasPerCallContextUsage: true,
        perCallInputTokens: raw.inputTokens,
        perCallCacheCreationTokens: raw.cacheCreationTokens,
        perCallCacheReadTokens: raw.cacheReadTokens,
        modelUsage: prevForFallback?.modelUsage,
      });
      return { sessionUsage: updated };
    });
  },

  clearUsage: (sessionId) => {
    set((state) => {
      const updated = new Map(state.sessionUsage);
      updated.delete(sessionId);
      return { sessionUsage: updated };
    });
  },
}));
