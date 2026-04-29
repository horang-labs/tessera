'use client';

import { useState, memo } from 'react';
import Image from 'next/image';
import type { FileReadToolResult } from '@/types/tool-result';

const MAX_DISPLAY_LINES = 50;

interface ReadResultProps {
  result: FileReadToolResult;
  filePath?: string;
}

export const ReadResult = memo(function ReadResult({ result, filePath }: ReadResultProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (result.contentType === 'image') {
    const { base64, mimeType, dimensions } = result;
    return (
      <div className="space-y-1">
        {filePath && (
          <div className="text-[10px] text-(--text-muted) font-mono">{filePath}</div>
        )}
        <Image
          src={`data:${mimeType};base64,${base64}`}
          alt={filePath || 'Image'}
          width={dimensions.displayWidth}
          height={dimensions.displayHeight}
          unoptimized
          sizes={`${dimensions.displayWidth}px`}
          className="rounded max-w-full h-auto"
        />
        <div className="text-[10px] text-(--text-muted)">
          {dimensions.originalWidth}x{dimensions.originalHeight}
        </div>
      </div>
    );
  }

  // Text file
  const { content, lineCount, startLine, totalLines } = result;
  const displayPath = filePath || result.path;
  const ext = displayPath?.split('.').pop() || '';
  const lines = content.split('\n');
  const isLong = lines.length > MAX_DISPLAY_LINES;
  const displayLines = isExpanded ? lines : lines.slice(0, MAX_DISPLAY_LINES);

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        {displayPath && (
          <span className="text-[10px] text-(--text-muted) font-mono truncate max-w-[300px]">
            {displayPath}
          </span>
        )}
        {ext && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-(--accent)/10 text-(--accent)">
            .{ext}
          </span>
        )}
        {startLine > 1 && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-(--tool-param-bg) text-(--text-muted)">
            Lines {startLine}-{startLine + lineCount - 1} of {totalLines}
          </span>
        )}
      </div>

      {/* Content with line numbers */}
      <pre className="text-[11px] text-(--text-secondary) bg-(--tool-output-bg) rounded overflow-x-auto font-mono whitespace-pre">
        {displayLines.map((line, i) => (
          <div key={i} className="flex hover:bg-white/5">
            <span className="select-none text-(--text-muted)/50 text-right w-10 pr-2 shrink-0">
              {startLine + i}
            </span>
            <span className="whitespace-pre-wrap break-all">{line}</span>
          </div>
        ))}
      </pre>

      {isLong && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(v => !v); }}
          className="text-[11px] text-(--accent) hover:text-(--accent-light) transition-colors"
        >
          {isExpanded ? 'collapse' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
});
