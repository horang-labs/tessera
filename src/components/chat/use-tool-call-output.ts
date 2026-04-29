'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { ToolCallMessage } from '@/types/chat';
import { resolveToolUseId } from './tool-call-block-utils';

interface UseToolCallOutputArgs {
  id: string;
  explicitToolUseId?: string;
  output?: ToolCallMessage['output'];
  toolUseResult?: ToolCallMessage['toolUseResult'];
  hasOutput?: ToolCallMessage['hasOutput'];
  sessionId?: ToolCallMessage['sessionId'];
  status: ToolCallMessage['status'];
  defaultExpanded?: boolean;
}

export function useToolCallOutput({
  id,
  explicitToolUseId,
  output,
  toolUseResult,
  hasOutput,
  sessionId,
  status,
  defaultExpanded,
}: UseToolCallOutputArgs) {
  const [loadError, setLoadError] = useState<string | null>(null);

  const toolUseId = useMemo(
    () => resolveToolUseId(id, explicitToolUseId),
    [explicitToolUseId, id],
  );

  const cachedOutput = useChatStore((state) =>
    toolUseId ? state.toolOutputCache.get(toolUseId) : undefined,
  );

  const effectiveOutput = output ?? cachedOutput?.output;
  const effectiveToolUseResult = toolUseResult ?? cachedOutput?.toolUseResult;
  const isError = Boolean(status === 'error' || cachedOutput?.isError);
  const needsLazyFetch = Boolean(hasOutput && effectiveOutput == null && !effectiveToolUseResult);
  const needsStructuredFetch = Boolean(
    !needsLazyFetch
    && toolUseId
    && sessionId
    && effectiveOutput != null
    && !effectiveToolUseResult
    && status !== 'running',
  );

  const fetchToolOutput = useCallback(async () => {
    if (!toolUseId || !sessionId) return;
    if (useChatStore.getState().getToolOutput(toolUseId)) return;

    setLoadError(null);

    const retryDelays = [500, 1000, 2000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        const params = new URLSearchParams({ toolUseId });
        const response = await fetch(`/api/sessions/${sessionId}/tool-output?${params}`);

        if (response.status === 404 && attempt < retryDelays.length) {
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }

        if (!response.ok) {
          throw new Error(`Failed to load tool output (${response.status})`);
        }

        const data = await response.json();
        useChatStore.getState().setToolOutput(sessionId, toolUseId, {
          output: data.output,
          toolUseResult: data.toolUseResult,
          isError: data.isError,
        });
        return;
      } catch (error) {
        if (attempt >= retryDelays.length) {
          setLoadError((error as Error).message);
        }
      }
    }
  }, [sessionId, toolUseId]);

  useEffect(() => {
    if (defaultExpanded && needsLazyFetch) {
      fetchToolOutput();
    }
  }, [defaultExpanded, fetchToolOutput, needsLazyFetch]);

  useEffect(() => {
    if (needsStructuredFetch) {
      fetchToolOutput();
    }
  }, [fetchToolOutput, needsStructuredFetch]);

  return {
    toolUseId,
    loadError,
    effectiveOutput,
    effectiveToolUseResult,
    isError,
    needsLazyFetch,
    needsStructuredFetch,
    fetchToolOutput,
  };
}
