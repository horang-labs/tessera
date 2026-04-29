'use client';

import { useState, memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SearchToolResult } from '@/types/tool-result';

const MAX_FILES = 10;

interface SearchResultProps {
  result: SearchToolResult;
  toolName: 'Grep' | 'Glob';
}

export const SearchResult = memo(function SearchResult({ result, toolName }: SearchResultProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const filenames = result.files || [];
  const numFiles = result.totalFiles;
  const truncated = result.source === 'glob' ? !!result.truncated : false;
  const displayFiles = isExpanded ? filenames : filenames.slice(0, MAX_FILES);

  return (
    <div className="space-y-1">
      {/* Header badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-(--accent)/10 text-(--accent)">
          {numFiles} file{numFiles !== 1 ? 's' : ''}
        </span>
        {result.source === 'glob' && result.durationMs != null && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-(--tool-param-bg) text-(--text-muted)">
            {result.durationMs}ms
          </span>
        )}
        {truncated && (
          <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-(--status-warning-bg) text-(--status-warning-text)">
            <AlertTriangle className="w-2.5 h-2.5" />
            Truncated
          </span>
        )}
      </div>

      {/* Grep content mode: show matched lines */}
      {result.source === 'grep' && result.mode === 'content' && result.content && (
        <pre className="text-[11px] text-(--text-secondary) bg-(--tool-output-bg) px-2.5 py-2 rounded overflow-x-auto font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto">
          {result.content}
        </pre>
      )}

      {/* File list */}
      {displayFiles.length > 0 && (
        <div className="text-[11px] font-mono space-y-0.5">
          {displayFiles.map((file, i) => (
            <div key={i} className="text-(--text-muted) truncate px-1 hover:text-(--text-secondary) transition-colors">
              {file}
            </div>
          ))}
        </div>
      )}

      {filenames.length > MAX_FILES && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(v => !v); }}
          className="text-[11px] text-(--accent) hover:text-(--accent-light) transition-colors"
        >
          {isExpanded ? 'collapse' : `... +${filenames.length - MAX_FILES} more files`}
        </button>
      )}
    </div>
  );
});
