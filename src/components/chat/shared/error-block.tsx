'use client';

import { useState, memo } from 'react';
import { XCircle, ChevronRight, ChevronDown } from 'lucide-react';

interface ErrorBlockProps {
  /** Error message text */
  message: string;
  /** Optional title (default: "Error") */
  title?: string;
  /** Max lines before collapsing (default: 5) */
  maxLines?: number;
}

/**
 * Standardized error display block.
 * Used across all tool result components for consistent error styling.
 */
export const ErrorBlock = memo(function ErrorBlock({
  message,
  title = 'Error',
  maxLines = 5,
}: ErrorBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const lines = message.split('\n');
  const isLong = lines.length > maxLines;
  const displayText = isExpanded || !isLong
    ? message
    : lines.slice(0, maxLines).join('\n');

  return (
    <div
      className="rounded-lg border-2 border-(--status-error-border) bg-(--status-error-bg) overflow-hidden"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <XCircle className="w-3.5 h-3.5 text-(--status-error-text) shrink-0" />
        <span className="text-xs font-medium text-(--status-error-text)">{title}</span>
      </div>
      <pre className="px-3 pb-2 text-[11px] text-(--status-error-text) font-mono whitespace-pre-wrap overflow-x-auto max-h-[300px] overflow-y-auto">
        {displayText}
      </pre>
      {isLong && (
        <button
          onClick={() => setIsExpanded(v => !v)}
          className="flex items-center gap-1 px-3 pb-2 text-[10px] text-(--status-error-text) hover:text-(--status-error-text) transition-colors"
        >
          {isExpanded
            ? <><ChevronDown className="w-2.5 h-2.5" /> Show less</>
            : <><ChevronRight className="w-2.5 h-2.5" /> +{lines.length - maxLines} more lines</>
          }
        </button>
      )}
    </div>
  );
});
