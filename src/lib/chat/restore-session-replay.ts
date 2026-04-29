import { useChatStore } from '@/stores/chat-store';
import { useUsageStore } from '@/stores/usage-store';
import type { ActiveInteractivePrompt, EnhancedMessage } from '@/types/chat';

import type { ModelUsageEntry } from '@/lib/ws/message-types';

interface ReplayUsage {
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
}

interface ReplayContextUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  contextWindowSize?: number;
}

export interface SessionReplayPayload {
  messages: EnhancedMessage[];
  usage?: ReplayUsage | null;
  contextUsage?: ReplayContextUsage | null;
  activeInteractivePrompt?: ActiveInteractivePrompt | null;
}

export function restoreSessionReplay(sessionId: string, replay: SessionReplayPayload): void {
  const chatStore = useChatStore.getState();
  chatStore.loadHistory(sessionId, replay.messages);
  chatStore.setActiveInteractivePrompt(sessionId, replay.activeInteractivePrompt ?? null);

  const usageStore = useUsageStore.getState();
  usageStore.clearUsage(sessionId);

  if (replay.usage) {
    usageStore.updateUsage(sessionId, {
      inputTokens: replay.usage.inputTokens,
      outputTokens: replay.usage.outputTokens,
      cacheReadTokens: replay.usage.cacheReadTokens,
      cacheCreationTokens: replay.usage.cacheCreationTokens,
      contextWindowSize: replay.usage.contextWindowSize,
      maxOutputTokens: replay.usage.maxOutputTokens,
      durationApiMs: replay.usage.durationApiMs,
      costUsd: replay.usage.costUsd,
      numTurns: replay.usage.numTurns,
      modelUsage: replay.usage.modelUsage,
    });
  }

  if (replay.contextUsage) {
    usageStore.updateContextUsage(sessionId, {
      inputTokens: replay.contextUsage.inputTokens,
      cacheCreationTokens: replay.contextUsage.cacheCreationTokens,
      cacheReadTokens: replay.contextUsage.cacheReadTokens,
      contextWindowSize: replay.contextUsage.contextWindowSize,
    });
  }
}
