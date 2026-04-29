'use client';

import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import type { ToolCallKind } from '@/types/tool-call-kind';
import { ErrorBlock } from './shared/error-block';
import { renderToolCallResult, TOOL_STATUS_TEXT } from './tool-call-block-utils';

export function ToolCallBlockHeader({
  toolName,
  displayName,
  summary,
  toolIcon,
  status,
  statusColor,
  isError,
  isRunning,
  onToggle,
}: {
  toolName: string;
  displayName: string;
  summary: string;
  toolIcon: ReactNode;
  status: 'running' | 'completed' | 'error';
  statusColor: string;
  isError: boolean;
  isRunning: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      data-testid={`tool-call-${toolName.toLowerCase()}-header`}
      className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-(--tool-header-hover)"
    >
      <div className={`${statusColor} shrink-0`}>{toolIcon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-(--text-secondary)">{displayName}</div>
        {summary && (
          <div className="truncate font-mono text-[11px] text-(--text-muted)">{summary}</div>
        )}
      </div>
      <div className="ml-auto flex h-3 w-3 shrink-0 items-center justify-center">
        {isRunning && <Loader2 className="h-3 w-3 animate-spin text-(--accent)" />}
        {status === 'completed' && <CheckCircle className={`h-3 w-3 ${TOOL_STATUS_TEXT.completed}`} />}
        {isError && <XCircle className={`h-3 w-3 ${TOOL_STATUS_TEXT.error}`} />}
      </div>
    </button>
  );
}

export function ToolCallBlockContent({
  inGrid,
  loadError,
  effectiveOutput,
  formattedParams,
  effectiveToolUseResult,
  toolName,
  toolKind,
  toolParams,
  toolDisplay,
  isError,
  isOutputExpanded,
  truncatedOutput,
  isLong,
  remainingLines,
  error,
  onRetry,
  onToggleOutput,
}: {
  inGrid: boolean;
  loadError: string | null;
  effectiveOutput?: string;
  formattedParams: string;
  effectiveToolUseResult: unknown;
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
  isError: boolean;
  isOutputExpanded: boolean;
  truncatedOutput: string;
  isLong: boolean;
  remainingLines: number;
  error?: string;
  onRetry: () => void;
  onToggleOutput: () => void;
}) {
  const renderedToolResult = effectiveToolUseResult
    ? renderToolCallResult({
        toolName,
        toolKind,
        toolUseResult: effectiveToolUseResult,
        toolParams,
        toolDisplay,
      })
    : null;

  return (
    <div className={inGrid ? 'space-y-2' : 'space-y-2 px-3 pb-3'}>
      {loadError && effectiveOutput == null && (
        <div className="px-2.5 py-2">
          <ErrorBlock message={loadError} title="Failed to load output" />
          <button
            data-testid="tool-output-retry"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            className="mt-1 text-[11px] text-(--accent) hover:text-(--accent-light)"
          >
            Retry
          </button>
        </div>
      )}

      {formattedParams && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-(--tool-param-bg) px-2.5 py-2 font-mono text-[11px] text-(--text-muted)">
          {formattedParams}
        </pre>
      )}

      {renderedToolResult || (
        effectiveOutput == null ? null : (
          <div>
            <pre
              className={`overflow-x-auto whitespace-pre-wrap rounded bg-(--tool-output-bg) px-2.5 py-2 font-mono text-[11px] ${
                isError ? 'text-(--status-error-text)' : 'text-(--text-secondary)'
              }`}
            >
              {isOutputExpanded ? effectiveOutput : truncatedOutput}
            </pre>
            {isLong && !isOutputExpanded && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleOutput();
                }}
                className="mt-1 text-[11px] text-(--accent) transition-colors hover:text-(--accent-light)"
              >
                ... +{remainingLines} lines (click to expand)
              </button>
            )}
            {isOutputExpanded && isLong && (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleOutput();
                }}
                className="mt-1 text-[11px] text-(--accent) transition-colors hover:text-(--accent-light)"
              >
                collapse
              </button>
            )}
          </div>
        )
      )}

      {error && <ErrorBlock message={error} />}
    </div>
  );
}
