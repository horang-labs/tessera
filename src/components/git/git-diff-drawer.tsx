'use client';

import { ChevronLeft, ChevronRight, GitBranch } from 'lucide-react';
import { BottomDrawer } from '@/components/ui/bottom-drawer';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { GitChangedFile, GitDiffData } from '@/types/git';
import { DiffPreview } from './git-panel-sections';
import { FILE_STATE_META } from './git-panel-shared';

interface GitDiffDrawerProps {
  selectedFile: GitChangedFile | null;
  selectedFileIndex: number;
  changedFileCount: number;
  diffData: GitDiffData | null;
  diffLoading: boolean;
  diffError: string | null;
  height: number;
  onClose: () => void;
  onMoveSelection: (direction: -1 | 1) => void;
  onResize?: (height: number) => void;
}

export function GitDiffDrawer({
  selectedFile,
  selectedFileIndex,
  changedFileCount,
  diffData,
  diffLoading,
  diffError,
  height,
  onClose,
  onMoveSelection,
  onResize,
}: GitDiffDrawerProps) {
  const stateMeta = selectedFile ? FILE_STATE_META[selectedFile.state] : null;
  const position =
    changedFileCount > 0
      ? `${Math.max(selectedFileIndex + 1, 1)} / ${changedFileCount}`
      : '—';

  const title = selectedFile ? (
    <span className="font-mono text-xs">{selectedFile.path}</span>
  ) : (
    <span className="text-xs">No file selected</span>
  );

  const subtitle =
    stateMeta && selectedFile ? (
      <span
        className={cn(
          'rounded border px-1.5 py-[1px] text-[10px] font-medium uppercase tracking-[0.08em]',
          stateMeta.className,
        )}
      >
        {stateMeta.label}
        {diffData?.truncated ? ' · truncated' : ''}
      </span>
    ) : null;

  const headerActions = (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip content="Previous file">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onMoveSelection(-1)}
          disabled={selectedFileIndex <= 0}
          aria-label="Previous file"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </Tooltip>
      <span className="min-w-[46px] text-center font-mono text-[11px] tabular-nums text-(--text-muted)">
        {position}
      </span>
      <Tooltip content="Next file">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onMoveSelection(1)}
          disabled={
            changedFileCount === 0 ||
            selectedFileIndex === -1 ||
            selectedFileIndex >= changedFileCount - 1
          }
          aria-label="Next file"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>
  );

  return (
    <BottomDrawer
      icon={<GitBranch className="h-4 w-4" />}
      title={title}
      subtitle={subtitle}
      headerActions={headerActions}
      onClose={onClose}
      height={height}
      onResize={onResize}
    >
      <div className="h-full p-3">
        <DiffPreview
          selectedFile={selectedFile}
          diffData={diffData}
          diffLoading={diffLoading}
          diffError={diffError}
          hideFileHeader
        />
      </div>
    </BottomDrawer>
  );
}
