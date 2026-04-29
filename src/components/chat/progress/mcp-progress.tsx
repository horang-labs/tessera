'use client';

import { memo, useState } from 'react';
import { Loader2, CheckCircle, XCircle, Plug, ChevronRight, ChevronDown, Clock, AlertTriangle } from 'lucide-react';
import type { McpProgressData } from '@/types/cli-jsonl-schemas';
import { useLiveElapsed } from '@/hooks/use-live-elapsed';
import { cn } from '@/lib/utils';
import { MESSAGE_BODY_OFFSET_CLASS } from '../message-layout';
import { MessageRowShell } from '../message-row-shell';

interface McpProgressProps {
  data: McpProgressData;
  alignWithMessageBody?: boolean;
}

/** Mask sensitive values in tool input (API keys, tokens, passwords) */
function maskValue(key: string, value: unknown): unknown {
  const sensitiveKeys = /key|token|secret|password|auth|credential/i;
  if (typeof value === 'string' && sensitiveKeys.test(key) && value.length > 4) {
    return '***' + value.slice(-3);
  }
  return value;
}

/** Format tool input as compact preview string */
function formatInputPreview(toolInput: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(toolInput)) {
    const masked = maskValue(key, value);
    if (typeof masked === 'string') {
      const truncated = masked.length > 50 ? masked.slice(0, 50) + '...' : masked;
      parts.push(`${key}="${truncated}"`);
    } else if (typeof masked === 'number' || typeof masked === 'boolean') {
      parts.push(`${key}=${String(masked)}`);
    }
  }
  const preview = parts.join(', ');
  return preview.length > 80 ? preview.slice(0, 80) + '...' : preview;
}

export const McpProgress = memo(function McpProgress({ data, alignWithMessageBody = true }: McpProgressProps) {
  const { status, serverName, toolName, elapsedTimeMs, toolInput, errorMessage, startTimestamp } = data;
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const liveElapsed = useLiveElapsed({
    isActive: status === 'started',
    startTime: startTimestamp,
  });

  const statusIcon = status === 'started'
    ? <Loader2 className="w-3 h-3 text-(--accent) animate-spin" />
    : status === 'completed'
      ? <CheckCircle className="w-3 h-3 text-(--success)" />
      : <XCircle className="w-3 h-3 text-(--error)" />;

  const borderClass = status === 'started'
    ? 'border-(--accent)/30 bg-(--accent)/5'
    : status === 'completed'
      ? 'border-(--tool-border) bg-(--tool-bg)'
      : 'border-(--status-error-border) bg-(--status-error-bg)';

  // Extract short server name (last segment after last colon)
  const shortServer = serverName.split(':').pop() || serverName;

  const displayElapsed = status === 'started'
    ? liveElapsed
    : elapsedTimeMs;

  const inputPreview = toolInput ? formatInputPreview(toolInput) : null;
  const hasSensitiveInput = toolInput && Object.keys(toolInput).some(k => /key|token|secret|password|auth|credential/i.test(k));

  const content = (
    <div className={cn(
      'my-1 max-w-2xl rounded-lg overflow-hidden border',
      alignWithMessageBody && MESSAGE_BODY_OFFSET_CLASS,
      borderClass,
    )}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Plug className="w-3.5 h-3.5 text-(--text-muted) shrink-0" />
        <span className="text-xs text-(--text-secondary)">{shortServer}</span>
        <span className="text-[10px] text-(--text-muted) font-mono">{toolName}</span>

        {/* Tool input preview */}
        {inputPreview && (
          <span className="text-[10px] text-(--text-muted) font-mono truncate max-w-[200px]" title={inputPreview}>
            ({inputPreview})
          </span>
        )}
        {hasSensitiveInput && (
          <span title="Contains masked sensitive values">
            <AlertTriangle className="w-2.5 h-2.5 text-(--status-warning-text) shrink-0" />
          </span>
        )}

        {/* Elapsed time */}
        {displayElapsed != null && displayElapsed > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-(--text-muted)">
            <Clock className="w-2.5 h-2.5" />
            {(displayElapsed / 1000).toFixed(1)}s
          </span>
        )}

        <div className="ml-auto shrink-0">{statusIcon}</div>
      </div>

      {/* Error message (expandable) */}
      {status === 'failed' && errorMessage && (
        <div className="px-3 pb-2">
          <button
            onClick={() => setIsErrorExpanded(v => !v)}
            className="flex items-center gap-1 text-[10px] text-(--status-error-text) hover:text-(--status-error-text) transition-colors"
          >
            {isErrorExpanded
              ? <ChevronDown className="w-2.5 h-2.5" />
              : <ChevronRight className="w-2.5 h-2.5" />
            }
            Error details
          </button>
          {isErrorExpanded && (
            <pre className="mt-1 text-[10px] text-(--status-error-text) bg-(--status-error-bg) border border-(--status-error-border) px-2 py-1.5 rounded font-mono whitespace-pre-wrap max-h-[100px] overflow-y-auto">
              {errorMessage}
            </pre>
          )}
        </div>
      )}
    </div>
  );

  if (!alignWithMessageBody) return content;
  return <MessageRowShell>{content}</MessageRowShell>;
});
