'use client';

import { useState, memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { CommandExecutionToolResult } from '@/types/tool-result';

const MAX_LINES = 20;

interface BashResultProps {
  result: CommandExecutionToolResult;
}

export const BashResult = memo(function BashResult({ result }: BashResultProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { stdout, stderr, interrupted, backgroundTaskId } = result;
  const hasContent = stdout || stderr || interrupted || backgroundTaskId;
  const lines = stdout ? stdout.split('\n') : [];
  const isLong = lines.length > MAX_LINES;
  const displayText = isExpanded ? stdout : lines.slice(0, MAX_LINES).join('\n');

  return (
    <div className="space-y-1.5">
      {/* Badges */}
      {(interrupted || backgroundTaskId) && (
        <div className="flex gap-1.5">
          {interrupted && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-(--status-warning-bg) text-(--status-warning-text)">
              <AlertTriangle className="w-2.5 h-2.5" />
              Interrupted
            </span>
          )}
          {backgroundTaskId && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-(--accent)/10 text-(--accent)">
              Background ({backgroundTaskId})
            </span>
          )}
        </div>
      )}

      {/* stdout */}
      {stdout && (
        <pre className="text-[11px] text-(--text-secondary) bg-(--tool-param-bg) px-2.5 py-2 rounded overflow-x-auto font-mono whitespace-pre-wrap leading-relaxed">
          {displayText}
        </pre>
      )}

      {isLong && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(v => !v); }}
          className="text-[11px] text-(--accent) hover:text-(--accent-light) transition-colors"
        >
          {isExpanded ? 'collapse' : `... +${lines.length - MAX_LINES} lines (click to expand)`}
        </button>
      )}

      {/* stderr */}
      {stderr && (
        <pre className="text-[11px] text-(--status-warning-text) bg-(--status-warning-bg) border border-(--status-warning-border) px-2.5 py-2 rounded overflow-x-auto font-mono whitespace-pre-wrap">
          {stderr}
        </pre>
      )}

      {/* No output at all */}
      {!hasContent && (
        <span className="text-[11px] text-(--text-muted) italic">No output</span>
      )}
    </div>
  );
});
