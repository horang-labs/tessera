'use client';

import { useState } from 'react';
import { Brain, Clock, Zap, CheckCircle } from 'lucide-react';
import type { ThinkingMessage } from '@/types/chat';
import { useI18n } from '@/lib/i18n';
import { useLiveElapsed } from '@/hooks/use-live-elapsed';
import { cn } from '@/lib/utils';
import { MESSAGE_BODY_OFFSET_CLASS } from './message-layout';
import { MessageRowShell } from './message-row-shell';
import { TOOL_STATUS_TEXT } from './tool-call-block-utils';

interface ThinkingBlockProps extends Omit<ThinkingMessage, 'id' | 'timestamp'> {
  alignWithMessageBody?: boolean;
}

function ThinkingBlockBody({
  content,
  status,
  isRedacted,
  tokenCount,
  startTime,
  endTime,
  elapsedMs,
  alignWithMessageBody = true,
}: ThinkingBlockProps) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const liveElapsed = useLiveElapsed({
    isActive: status === 'streaming',
    startTime,
  });

  const displayElapsed = status === 'completed' && elapsedMs != null
    ? elapsedMs
    : liveElapsed;
  const elapsedSec = (displayElapsed / 1000).toFixed(1);

  // Keep the collapsed header single-line; expand is only useful when there is
  // actual thinking content to show.
  const hasBody = content.trim().length > 0;

  // Hide empty thinking blocks that have nothing meaningful to show.
  // A completed block with no content, no elapsed time, and no token count is
  // visual noise — skip rendering it entirely.
  if (
    status === 'completed' &&
    !hasBody &&
    !isRedacted &&
    tokenCount == null &&
    (elapsedMs == null || elapsedMs === 0)
  ) {
    return null;
  }

  const isStreaming = status === 'streaming';
  const statusColor = isStreaming ? TOOL_STATUS_TEXT.running : TOOL_STATUS_TEXT.completed;

  const blockContent = (
    <div className={cn(
      'my-1.5 max-w-2xl overflow-hidden rounded-md',
      alignWithMessageBody && MESSAGE_BODY_OFFSET_CLASS,
    )}>
      <button
        onClick={hasBody ? () => setIsExpanded(!isExpanded) : undefined}
        disabled={!hasBody}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md border border-(--tool-border) bg-(--tool-bg) text-left transition-colors ${
          hasBody ? 'cursor-pointer hover:bg-(--tool-header-hover)' : 'cursor-default'
        }`}
        data-testid="thinking-block-toggle"
        aria-expanded={isExpanded}
      >
        <div className={`${statusColor} shrink-0`}>
          <Brain className="h-3.5 w-3.5" />
        </div>

        <span className="text-[11px] font-medium text-(--text-secondary) shrink-0">
          {isStreaming ? t('thinking.label') : t('thinking.labelCompleted')}
        </span>
        {content.length > 0 && (
          <span className="text-[11px] font-normal text-(--text-muted)">
            {content.length < 1000 ? `~${content.length} ${content.length === 1 ? 'token' : 'tokens'}` : `~${(content.length / 1000).toFixed(1)}k tokens`}
          </span>
        )}
        {displayElapsed > 0 && (
          <span className="text-[11px] font-normal text-(--text-muted)">
            {elapsedSec}s
          </span>
        )}

        <div className="shrink-0 ml-auto">
          {isStreaming && (
            <div className="flex gap-1">
              <span className="typing-dot w-1 h-1 bg-(--accent) rounded-full" />
              <span className="typing-dot w-1 h-1 bg-(--accent) rounded-full" />
              <span className="typing-dot w-1 h-1 bg-(--accent) rounded-full" />
            </div>
          )}
          {status === 'completed' && (
            <CheckCircle className={`w-2.5 h-2.5 ${TOOL_STATUS_TEXT.completed}`} />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          {/* Metadata bar */}
          {status === 'completed' && (tokenCount != null || elapsedMs != null) && (
            <div className="flex items-center gap-3 mb-2 text-[10px] text-(--text-muted)">
              {tokenCount != null && (
                <span className="inline-flex items-center gap-0.5">
                  <Zap className="w-2.5 h-2.5" />
                  {tokenCount.toLocaleString()} tokens
                </span>
              )}
              {elapsedMs != null && (
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="w-2.5 h-2.5" />
                  {(elapsedMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          )}

          <div className="text-xs italic text-(--text-muted) leading-relaxed whitespace-pre-wrap">
            {content}
          </div>
        </div>
      )}
    </div>
  );

  if (!alignWithMessageBody) return blockContent;
  return <MessageRowShell>{blockContent}</MessageRowShell>;
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  return <ThinkingBlockBody key={props.status} {...props} />;
}
