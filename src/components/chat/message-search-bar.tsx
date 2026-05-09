'use client';

import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface MessageSearchBarProps {
  query: string;
  matchCount: number;
  activeMatchIndex: number;
  hasMore: boolean;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function MessageSearchBar({
  query,
  matchCount,
  activeMatchIndex,
  hasMore,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: MessageSearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const hasQuery = query.trim().length > 0;
  const canNavigate = matchCount > 0;
  const counterLabel = hasQuery
    ? canNavigate
      ? t('chat.search.count', {
          current: String(activeMatchIndex + 1),
          total: String(matchCount),
        })
      : t('chat.search.noMatches')
    : '';

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className={cn(
        'flex h-7 min-w-0 items-center gap-1 rounded-md border border-(--input-border)',
        'bg-(--input-bg) px-1.5 text-(--text-secondary) shadow-sm',
      )}
      data-testid="message-search-bar"
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t('chat.search.placeholder')}
        aria-label={t('chat.search.placeholder')}
        className="h-full w-28 min-w-0 bg-transparent text-xs text-(--text-primary) outline-none placeholder:text-(--text-muted) sm:w-36"
      />
      <span
        className="min-w-[3.5rem] text-right text-[11px] leading-none text-(--text-muted)"
        title={hasMore ? t('chat.search.loadedOnlyHint') : undefined}
      >
        {counterLabel}
      </span>
      <button
        type="button"
        onClick={onPrevious}
        disabled={!canNavigate}
        title={t('chat.search.previous')}
        aria-label={t('chat.search.previous')}
        className="rounded p-0.5 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!canNavigate}
        title={t('chat.search.next')}
        aria-label={t('chat.search.next')}
        className="rounded p-0.5 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title={t('chat.search.close')}
        aria-label={t('chat.search.close')}
        className="rounded p-0.5 text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
