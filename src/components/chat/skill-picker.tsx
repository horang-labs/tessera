'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { SkillInfo } from '@/hooks/use-skill-picker';
import { useI18n } from '@/lib/i18n';

interface SkillPickerProps {
  isOpen: boolean;
  isLoading?: boolean;
  isInactive?: boolean;
  skills: SkillInfo[];
  selectedIndex: number;
  onSelect: (skill: SkillInfo) => void;
  onClose: () => void;
}

export function SkillPicker({
  isOpen,
  isLoading,
  isInactive,
  skills,
  selectedIndex,
  onSelect,
  onClose,
}: SkillPickerProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex === 0 && listRef.current) {
      // First item: scroll the container to top so sticky 'Skills' header doesn't obscure it
      listRef.current.scrollTop = 0;
    } else {
      const item = itemRefs.current[selectedIndex];
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  // Close on outside click
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

  if (!isOpen || (skills.length === 0 && !isLoading && !isInactive)) return null;

  return (
    <div
      ref={listRef}
      className={cn(
        'absolute bottom-full left-0 right-0 mb-1 z-50',
        'max-h-[280px] overflow-y-auto',
        'rounded-lg border-2 border-(--accent-dim)/40',
        'shadow-2xl shadow-black/60',
      )}
      style={{ backgroundColor: 'var(--sidebar-bg)' }}
      role="listbox"
    >
      {/* Header */}
      <div className="sticky top-0 px-3 py-1.5 text-[11px] font-medium text-(--text-muted) uppercase tracking-wider border-b border-(--divider)"
           style={{ backgroundColor: 'var(--sidebar-bg)' }}>
        Skills
      </div>

      {isInactive && skills.length === 0 && (
        <div className="px-3 py-4 text-xs text-(--text-muted)">
          {t('chat.skillPickerInactive')}
        </div>
      )}

      {isLoading && skills.length === 0 && (
        <div className="px-3 py-4 flex items-center gap-2 text-(--text-muted)">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-xs">{t('chat.skillsLoading')}</span>
        </div>
      )}

      {skills.map((skill, idx) => (
        <button
          key={`${skill.name}-${idx}`}
          ref={(el) => { itemRefs.current[idx] = el; }}
          role="option"
          aria-selected={idx === selectedIndex}
          onClick={() => onSelect(skill)}
          className={cn(
            'w-full text-left px-3 py-2.5 flex flex-col gap-0.5',
            'transition-colors duration-75',
            'border-b border-(--divider)/50 last:border-b-0',
            idx === selectedIndex
              ? 'bg-(--accent-dim)/20 text-(--accent-light)'
              : 'text-(--text-primary) hover:bg-(--sidebar-hover)',
          )}
        >
          <span className="text-sm font-semibold">/{skill.name}</span>
          {skill.description && (
            <span className={cn(
              'text-xs line-clamp-1',
              idx === selectedIndex ? 'text-(--text-secondary)' : 'text-(--text-muted)',
            )}>
              {skill.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
