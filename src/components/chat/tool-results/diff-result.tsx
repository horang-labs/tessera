'use client';

import { useState, memo } from 'react';
import { cn } from '@/lib/utils';
import type { FileChangeToolResult } from '@/types/tool-result';
import type { StructuredPatchHunk } from '@/types/cli-jsonl-schemas';

const MAX_LINES_PER_HUNK = 100;

interface DiffResultProps {
  result: FileChangeToolResult;
  toolName: 'Edit' | 'Write';
}

export const DiffResult = memo(function DiffResult({ result, toolName }: DiffResultProps) {
  const [expandedHunks, setExpandedHunks] = useState<Set<number>>(new Set());

  const filePath = result.path;
  const rawHunks = result.diff || [];
  const isCreate = result.operation === 'create';

  // CLI sends structuredPatch: [] for new file creation but includes content.
  // Synthesize an "all added" hunk so the full content is visible.
  const hunks: StructuredPatchHunk[] = (rawHunks.length === 0 && isCreate && result.afterText)
    ? [{
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: result.afterText.split('\n').length,
        lines: result.afterText.split('\n').map(l => '+' + l),
      }]
    : rawHunks;
  const userModified = !!result.userModified;
  const replaceAll = !!result.replaceAll;

  const toggleHunk = (idx: number) => {
    setExpandedHunks(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-(--text-muted) font-mono truncate max-w-[300px]">
          {filePath}
        </span>
        {isCreate && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-(--status-success-bg) text-(--status-success-text)">
            New file
          </span>
        )}
        {!isCreate && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-(--status-info-bg) text-(--status-info-text)">
            Modified
          </span>
        )}
        {userModified && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-(--status-warning-bg) text-(--status-warning-text)">
            User modified
          </span>
        )}
        {replaceAll && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-(--accent)/10 text-(--accent)">
            Replace all
          </span>
        )}
      </div>

      {/* Hunks */}
      {hunks.map((hunk, idx) => (
        <HunkView
          key={idx}
          hunk={hunk}
          index={idx}
          isExpanded={expandedHunks.has(idx)}
          onToggle={() => toggleHunk(idx)}
        />
      ))}

      {hunks.length === 0 && (
        <div className="text-[11px] text-(--text-muted) italic py-1">
          No diff available
        </div>
      )}
    </div>
  );
});

function HunkView({ hunk, index, isExpanded, onToggle }: {
  hunk: StructuredPatchHunk;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const lines = hunk.lines;
  const isLong = lines.length > MAX_LINES_PER_HUNK;
  const displayLines = isExpanded ? lines : lines.slice(0, MAX_LINES_PER_HUNK);

  let oldLineNo = hunk.oldStart;
  let newLineNo = hunk.newStart;

  return (
    <div className="rounded overflow-hidden border border-(--tool-border)">
      {/* Hunk header */}
      <div className="text-[10px] text-(--text-muted) bg-(--tool-param-bg) px-2 py-0.5 font-mono">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>

      {/* Diff lines */}
      <pre className="text-[11px] font-mono overflow-x-auto">
        {displayLines.map((line, i) => {
          const prefix = line[0] || ' ';
          const content = line.slice(1);
          let leftNo = '';
          let rightNo = '';

          if (prefix === '+') {
            rightNo = String(newLineNo++);
          } else if (prefix === '-') {
            leftNo = String(oldLineNo++);
          } else {
            leftNo = String(oldLineNo++);
            rightNo = String(newLineNo++);
          }

          return (
            <div
              key={i}
              className={cn(
                'flex',
                prefix === '+' && 'bg-(--status-success-bg) text-(--status-success-text)',
                prefix === '-' && 'bg-(--status-error-bg) text-(--status-error-text)',
                prefix !== '+' && prefix !== '-' && 'text-(--text-secondary)',
              )}
            >
              <span className="select-none text-(--text-muted)/40 text-right w-8 pr-1 shrink-0">{leftNo}</span>
              <span className="select-none text-(--text-muted)/40 text-right w-8 pr-1 shrink-0">{rightNo}</span>
              <span className="select-none w-4 text-center shrink-0">{prefix}</span>
              <span className="whitespace-pre-wrap break-all">{content}</span>
            </div>
          );
        })}
      </pre>

      {isLong && !isExpanded && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="w-full text-center text-[11px] text-(--accent) bg-(--tool-param-bg) py-1 hover:bg-(--tool-header-hover) transition-colors"
        >
          Show full diff ({lines.length} lines)
        </button>
      )}
    </div>
  );
}
