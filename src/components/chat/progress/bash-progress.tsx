'use client';

import { memo } from 'react';
import { Terminal } from 'lucide-react';
import type { BashProgressData } from '@/types/cli-jsonl-schemas';

interface BashProgressProps {
  data: BashProgressData;
}

export const BashProgress = memo(function BashProgress({ data }: BashProgressProps) {
  const { output, elapsedTimeSeconds, totalLines, timeoutMs } = data;
  const timeoutSec = timeoutMs != null && timeoutMs > 0 ? timeoutMs / 1000 : null;
  const progress = timeoutSec != null
    ? Math.min((elapsedTimeSeconds / timeoutSec) * 100, 100)
    : null;

  return (
    <div className="my-1 max-w-2xl rounded-lg overflow-hidden border border-(--accent)/30 bg-(--accent)/5">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Terminal className="w-3.5 h-3.5 text-(--accent) shrink-0" />
        <span className="text-xs text-(--accent)">Bash</span>
        <span className="text-[10px] text-(--text-muted)">{elapsedTimeSeconds}s elapsed</span>
        {totalLines > 0 && (
          <span className="text-[10px] text-(--text-muted)">{totalLines} lines</span>
        )}
        {/* Timeout bar */}
        {progress != null && (
          <div className="ml-auto w-16 h-1 bg-(--divider) rounded-full overflow-hidden">
            <div
              className="h-full bg-(--accent) transition-all duration-1000"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Output preview */}
      {output && (
        <pre className="text-[11px] text-(--text-secondary) bg-(--tool-param-bg) mx-2 mb-2 px-2 py-1.5 rounded font-mono whitespace-pre-wrap max-h-[100px] overflow-y-auto leading-relaxed">
          {output}
        </pre>
      )}
    </div>
  );
});
