'use client';

import { FolderGit2, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionRefItem } from '@/types/session-ref';

interface SessionRefChipProps {
  item: SessionRefItem;
  onRemove: () => void;
  onRetry: () => void;
}

export function SessionRefChip({ item, onRemove, onRetry }: SessionRefChipProps) {
  const isPending = item.status === 'pending';
  const isError = item.status === 'error';

  return (
    <div
      data-session-ref-status={item.status}
      className={cn(
        'relative shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
        'border text-xs group',
        item.status === 'ready' && 'bg-(--accent)/8 border-(--accent)/25 text-(--text-secondary)',
        isPending && 'bg-(--warning)/8 border-(--warning)/30 text-(--text-secondary)',
        isError && 'bg-(--error)/8 border-(--error)/30 text-(--text-secondary)',
      )}
    >
      {isPending ? (
        <span
          className="h-3 w-3 rounded-full border border-(--warning)/25 border-t-(--warning) animate-spin"
          aria-hidden="true"
        />
      ) : isError ? (
        <span className="text-(--error)">!</span>
      ) : item.kind === 'task' ? (
        <FolderGit2 className="w-3.5 h-3.5 shrink-0 text-(--accent)" aria-hidden="true" />
      ) : (
        <MessageSquare className="w-3.5 h-3.5 shrink-0 text-(--accent)" aria-hidden="true" />
      )}
      <span className="max-w-[160px] truncate font-medium">{item.title}</span>
      {isPending && (
        <span className="text-[10px] text-(--warning)">Preparing</span>
      )}
      {isError && (
        <span className="text-[10px] text-(--error)">Failed</span>
      )}
      {isError && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            'text-(--error) hover:bg-(--error)/15',
          )}
          aria-label={`Retry session reference: ${item.title}`}
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className={cn(
          'w-4 h-4 flex items-center justify-center rounded-full',
          'text-(--text-muted) text-[10px] leading-none',
          'opacity-0 group-hover:opacity-100 transition-opacity',
          'hover:bg-(--error)/20 hover:text-(--error)',
        )}
        aria-label={`Remove session reference: ${item.title}`}
      >
        &times;
      </button>
    </div>
  );
}
