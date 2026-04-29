'use client';

import { useState, memo } from 'react';
import { ExternalLink, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  WebFetchToolResultCanonical,
  WebSearchToolResultCanonical,
  WebToolResult,
} from '@/types/tool-result';

interface WebResultProps {
  result: WebToolResult;
  toolName: 'WebSearch' | 'WebFetch';
}

function isWebSearch(result: WebToolResult): result is WebSearchToolResultCanonical {
  return result.mode === 'search';
}

export const WebResult = memo(function WebResult({ result, toolName }: WebResultProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (isWebSearch(result)) {
    const { query, results, durationMs } = result;
    // Extract search result items
    const items: Array<{ title: string; url: string }> = [];
    items.push(...results);

    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-(--text-muted) italic truncate">&quot;{query}&quot;</span>
          <span className="text-[10px] text-(--text-muted) inline-flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {(durationMs / 1000).toFixed(1)}s
          </span>
        </div>
        {items.length > 0 && (
          <div className="space-y-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px] py-0.5">
                <ExternalLink className="w-3 h-3 text-(--accent) shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-(--text-secondary) truncate">{item.title}</div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-(--accent) hover:underline truncate block text-[10px]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.url}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // WebFetch
  const { url, statusCode, statusText, bytes, durationMs, content } = result as WebFetchToolResultCanonical;
  const statusColor = statusCode >= 200 && statusCode < 300 ? 'text-(--status-success-text) bg-(--status-success-bg)'
    : statusCode >= 400 && statusCode < 500 ? 'text-(--status-warning-text) bg-(--status-warning-bg)'
    : statusCode >= 500 ? 'text-(--status-error-text) bg-(--status-error-bg)'
    : 'text-(--text-muted) bg-(--tool-param-bg)';

  const previewLines = content ? content.split('\n').slice(0, 5).join('\n') : '';

  return (
    <div className="space-y-1.5">
      {/* URL + status */}
      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-(--accent) hover:underline truncate max-w-[400px] font-mono"
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>
        <span className={cn('text-[9px] px-1 py-0.5 rounded font-mono', statusColor)}>
          {statusCode} {statusText}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-[10px] text-(--text-muted)">
        <span>{(bytes / 1024).toFixed(1)} KB</span>
        <span>{(durationMs / 1000).toFixed(1)}s</span>
      </div>

      {/* Preview */}
      {previewLines && (
        <div>
          <pre className="text-[11px] text-(--text-secondary) bg-(--tool-output-bg) px-2.5 py-2 rounded overflow-x-auto font-mono whitespace-pre-wrap max-h-[100px] overflow-y-hidden">
            {isExpanded ? content : previewLines}
          </pre>
          {content && content.split('\n').length > 5 && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsExpanded(v => !v); }}
              className="mt-1 text-[11px] text-(--accent) hover:text-(--accent-light) transition-colors"
            >
              {isExpanded ? 'collapse' : `... +${content.split('\n').length - 5} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
