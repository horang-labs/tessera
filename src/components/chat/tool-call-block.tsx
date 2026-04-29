'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import type { ToolCallMessage } from '@/types/chat';
import { ToolCallBlockContent, ToolCallBlockHeader } from './tool-call-block-sections';
import {
  buildOutputPreview,
  formatToolParams,
  getToolBlockTone,
  getToolIcon,
  getToolSummary,
  shortenToolName,
} from './tool-call-block-utils';
import { useToolCallOutput } from './use-tool-call-output';

export { getToolIcon, getToolSummary, shortenToolName } from './tool-call-block-utils';

interface ToolCallBlockProps extends Omit<ToolCallMessage, 'timestamp'> {
  defaultExpanded?: boolean;
  inGrid?: boolean;
}

export const ToolCallBlock = memo(function ToolCallBlock({
  id,
  toolName,
  toolKind,
  toolParams,
  toolDisplay,
  status,
  output,
  error,
  toolUseResult,
  hasOutput,
  sessionId,
  toolUseId: explicitToolUseId,
  defaultExpanded,
  inGrid = false,
}: ToolCallBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded ?? false);
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);

  const isRunning = status === 'running';
  const effectiveExpanded = inGrid ? true : isExpanded;

  const {
    loadError,
    effectiveOutput,
    effectiveToolUseResult,
    isError,
    needsLazyFetch,
    needsStructuredFetch,
    fetchToolOutput,
  } = useToolCallOutput({
    id,
    explicitToolUseId,
    output,
    toolUseResult,
    hasOutput,
    sessionId,
    status,
    defaultExpanded,
  });

  const displayName = useMemo(() => shortenToolName(toolName), [toolName]);
  const toolIcon = useMemo(() => getToolIcon(toolName, toolKind), [toolKind, toolName]);
  const summary = useMemo(
    () => getToolSummary(toolName, toolParams, toolKind, toolDisplay),
    [toolDisplay, toolKind, toolName, toolParams],
  );
  const formattedParams = useMemo(
    () => formatToolParams(toolName, toolParams, toolKind, toolDisplay),
    [toolDisplay, toolKind, toolName, toolParams],
  );
  const outputPreview = useMemo(
    () => buildOutputPreview(effectiveOutput),
    [effectiveOutput],
  );
  const { statusColor, borderColor } = getToolBlockTone(isError, isRunning);

  const toggleExpand = useCallback(() => {
    setIsExpanded((current) => {
      const nextExpanded = !current;
      if (nextExpanded && (needsLazyFetch || needsStructuredFetch)) {
        fetchToolOutput();
      }
      return nextExpanded;
    });
  }, [fetchToolOutput, needsLazyFetch, needsStructuredFetch]);

  const toggleOutput = useCallback(() => {
    setIsOutputExpanded((current) => !current);
  }, []);

  return (
    <div
      className={
        inGrid
          ? ''
          : `my-1.5 max-w-2xl overflow-hidden rounded-lg border ${borderColor} bg-(--tool-bg)`
      }
    >
      {!inGrid && (
        <ToolCallBlockHeader
          toolName={toolName}
          displayName={displayName}
          summary={summary}
          toolIcon={toolIcon}
          status={status}
          statusColor={statusColor}
          isError={isError}
          isRunning={isRunning}
          onToggle={toggleExpand}
        />
      )}

      {effectiveExpanded && (
        <ToolCallBlockContent
          inGrid={inGrid}
          loadError={loadError}
          effectiveOutput={effectiveOutput}
          formattedParams={formattedParams}
          effectiveToolUseResult={effectiveToolUseResult}
          toolName={toolName}
          toolKind={toolKind}
          toolParams={toolParams}
          toolDisplay={toolDisplay}
          isError={isError}
          isOutputExpanded={isOutputExpanded}
          truncatedOutput={outputPreview.truncatedOutput}
          isLong={outputPreview.isLong}
          remainingLines={outputPreview.remainingLines}
          error={error}
          onRetry={fetchToolOutput}
          onToggleOutput={toggleOutput}
        />
      )}
    </div>
  );
});
