'use client';

import { AlertTriangle, AlertCircle, Clock, RefreshCw } from 'lucide-react';
import type { SystemMessage } from '@/types/chat';
import { cn } from '@/lib/utils';
import { MessageRowShell } from './message-row-shell';

interface SystemMessageBlockProps extends Omit<SystemMessage, 'id' | 'timestamp'> {}

export function SystemMessageBlock({ message, severity, subtype, metadata }: SystemMessageBlockProps) {
  // Subtype: turn_duration — compact duration badge
  if (subtype === 'turn_duration' && metadata?.durationMs) {
    const sec = (metadata.durationMs / 1000).toFixed(1);
    return (
      <MessageRowShell className="flex justify-center py-0.5">
        <span className="inline-flex items-center gap-1 text-[10px] text-(--text-muted) opacity-70">
          <Clock className="w-2.5 h-2.5" />
          {sec}s
        </span>
      </MessageRowShell>
    );
  }

  // Subtype: api_error — error banner with retry info
  if (subtype === 'api_error' && metadata) {
    const statusCode = metadata.error?.error?.error?.code || metadata.error?.status || '';
    const errorMsg = metadata.error?.error?.error?.message || message;
    const retryAttempt = metadata.retryAttempt;
    const maxRetries = metadata.maxRetries;
    const retryInSec = metadata.retryInMs ? (metadata.retryInMs / 1000).toFixed(0) : '';

    return (
      <MessageRowShell className="flex items-center gap-2 px-3 py-1.5 my-0.5 rounded text-[11px] text-(--status-error-text) bg-(--status-error-bg) border border-(--status-error-border)">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {statusCode && (
              <span className="px-1 py-0.5 rounded bg-(--status-error-bg) text-[10px] font-mono">{statusCode}</span>
            )}
            <span className="truncate">{typeof errorMsg === 'string' ? errorMsg : message}</span>
          </div>
        </div>
        {retryAttempt && (
          <span className="inline-flex items-center gap-1 text-[10px] text-(--status-error-text) opacity-70 shrink-0">
            <RefreshCw className="w-2.5 h-2.5" />
            {retryAttempt}/{maxRetries}
            {retryInSec && ` (${retryInSec}s)`}
          </span>
        )}
      </MessageRowShell>
    );
  }

  // Subtype: compact_boundary — context compaction notice
  if (subtype === 'compact_boundary' && metadata?.compactMetadata) {
    const m = metadata.compactMetadata;
    return (
      <MessageRowShell className="flex justify-center py-1">
        <span className="inline-flex items-center gap-1.5 text-[10px] text-(--text-muted) opacity-70 px-2 py-0.5 rounded-full bg-(--tool-param-bg)">
          <RefreshCw className="w-2.5 h-2.5" />
          Context compacted
          {m.summary_input_tokens && (
            <span className="font-mono">{Math.round(m.summary_input_tokens / 1000)}K tokens</span>
          )}
        </span>
      </MessageRowShell>
    );
  }

  // Usage/info messages: very subtle, no border, small text
  if (severity === 'info') {
    return (
      <MessageRowShell className="flex justify-center py-0.5">
        <span className="text-[10px] text-(--text-muted) opacity-70">
          {message}
        </span>
      </MessageRowShell>
    );
  }

  // Warning/Error: slightly more visible
  const isError = severity === 'error';

  return (
    <MessageRowShell className={cn(
      'flex items-center gap-1.5 px-3 py-1 my-0.5 rounded text-[11px]',
      isError
        ? 'text-(--status-error-text) bg-(--status-error-bg)'
        : 'text-(--status-warning-text) bg-(--status-warning-bg)'
    )}>
      {isError
        ? <AlertCircle className="w-3 h-3 shrink-0" />
        : <AlertTriangle className="w-3 h-3 shrink-0" />
      }
      <span>{message}</span>
    </MessageRowShell>
  );
}
