'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { ReferenceMatch } from '@/hooks/use-file-picker';
import { useI18n } from '@/lib/i18n';

interface FilePickerProps {
  isOpen: boolean;
  isLoading?: boolean;
  results: ReferenceMatch[];
  sectionBoundaries: { files: [number, number]; chats: [number, number]; tasks: [number, number] };
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

const SECTION_LABELS: Record<'files' | 'chats' | 'tasks', string> = {
  files: 'Files',
  chats: 'Chats',
  tasks: 'Tasks',
};

export function FilePicker({
  isOpen,
  isLoading,
  results,
  sectionBoundaries,
  selectedIndex,
  onSelect,
  onClose,
}: FilePickerProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (selectedIndex === 0 && listRef.current) {
      listRef.current.scrollTop = 0;
    } else {
      const item = itemRefs.current[selectedIndex];
      if (item) item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sections: Array<{ key: 'files' | 'chats' | 'tasks'; start: number; end: number }> = [
    { key: 'files', start: sectionBoundaries.files[0], end: sectionBoundaries.files[1] },
    { key: 'chats', start: sectionBoundaries.chats[0], end: sectionBoundaries.chats[1] },
    { key: 'tasks', start: sectionBoundaries.tasks[0], end: sectionBoundaries.tasks[1] },
  ];

  return (
    <div
      ref={listRef}
      data-testid="reference-picker"
      className={cn(
        'absolute bottom-full left-0 right-0 mb-1 z-50',
        'max-h-[320px] overflow-y-auto',
        'rounded-lg border-2 border-(--accent-dim)/40',
        'shadow-2xl shadow-black/60',
      )}
      style={{ backgroundColor: 'var(--sidebar-bg)' }}
      role="listbox"
      aria-label={t('chat.referencePicker')}
    >
      {isLoading && results.length === 0 && (
        <div className="px-3 py-4 flex items-center gap-2 text-(--text-muted)">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-xs">{t('chat.referencesLoading')}</span>
        </div>
      )}

      {!isLoading && results.length === 0 && (
        <div className="px-3 py-4 text-xs text-(--text-muted)">
          {t('chat.noReferenceMatches')}
        </div>
      )}

      {sections.map((section) => {
        if (section.start === section.end) return null;
        return (
          <div key={section.key}>
            <div
              className="sticky top-0 px-3 py-1.5 text-[11px] font-medium text-(--text-muted) uppercase tracking-wider border-b border-(--divider)"
              style={{ backgroundColor: 'var(--sidebar-bg)' }}
            >
              {SECTION_LABELS[section.key]}
            </div>
            {results.slice(section.start, section.end).map((item, offset) => {
              const idx = section.start + offset;
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={`${section.key}-${item.value}-${idx}`}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`reference-picker-item-${idx}`}
                  data-kind={item.kind}
                  onClick={() => onSelect(idx)}
                  className={cn(
                    'w-full text-left px-3 py-2 flex flex-col gap-0.5',
                    'transition-colors duration-75',
                    'border-b border-(--divider)/50 last:border-b-0',
                    isSelected
                      ? 'bg-(--accent-dim)/20 text-(--accent-light)'
                      : 'text-(--text-primary) hover:bg-(--sidebar-hover)',
                  )}
                  title={item.sublabel ? `${item.label}  ${item.sublabel}` : item.label}
                >
                  <span className="text-sm font-medium truncate">{item.label || '(untitled)'}</span>
                  {item.sublabel && (
                    <span
                      className={cn(
                        'text-xs truncate',
                        isSelected ? 'text-(--text-secondary)' : 'text-(--text-muted)',
                      )}
                    >
                      {item.sublabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
