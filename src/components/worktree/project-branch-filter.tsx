'use client';

import { Check, ChevronDown, Filter, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session-store';

interface ProjectBranchFilterProps {
  projectId: string;
  branches: string[];
  compact?: boolean;
}

const SEARCH_THRESHOLD = 7;
const MENU_WIDTH = 264;

/** Filters the folder-owned Project View; it never changes the checkout branch. */
export function ProjectBranchFilter({ projectId, branches, compact = false }: ProjectBranchFilterProps) {
  const { t } = useI18n();
  const selectedBranch = useSessionStore((state) => state.projectCreationBranchFilters[projectId]);
  const setBranchFilter = useSessionStore((state) => state.setProjectCreationBranchFilter);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const showSearch = branches.length >= SEARCH_THRESHOLD;
  const filteredBranches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? branches.filter((branch) => branch.toLocaleLowerCase().includes(normalized)) : branches;
  }, [branches, query]);

  useEffect(() => {
    if (!isOpen) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8);
      const estimatedHeight = Math.min(filteredBranches.length + 1, 8) * 36 + (showSearch ? 48 : 0) + 16;
      const top = rect.bottom + 6 + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 6)
        : rect.bottom + 6;
      setPosition({ top, left });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [filteredBranches.length, isOpen, showSearch]);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && showSearch) searchRef.current?.focus();
  }, [isOpen, showSearch]);

  if (branches.length === 0) return null;

  const selectedLabel = selectedBranch ?? t('chat.projectViewAllBranches');
  const choose = (branch?: string) => {
    setBranchFilter(projectId, branch);
    setQuery('');
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const trigger = (
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('chat.projectViewBranchFilterAriaLabel')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={t('chat.projectViewBranchFilterHint')}
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          // It is scoped metadata for the project, not a toolbar competing
          // with the worktree or the session groups below it.
          compact
            ? 'flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md px-1.5 transition-colors'
            : 'flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors',
          'text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--sidebar-text-active)',
          'focus-visible:bg-(--sidebar-hover) focus-visible:outline-none',
          isOpen && 'bg-(--sidebar-hover) text-(--sidebar-text-active)',
        )}
        data-testid="project-branch-view-filter-trigger"
      >
        <Filter className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {compact && selectedBranch && (
          <span className="min-w-0 truncate text-[0.625rem] font-medium text-(--sidebar-text-active)">
            {t('chat.projectViewBranchFilterMenuLabel')}: {selectedBranch}
          </span>
        )}
        {!compact && <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-(--sidebar-text-active)">{selectedLabel}</span>}
        {!compact && <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />}
      </button>
  );

  const menu = isOpen && position && typeof document !== 'undefined' && createPortal(
    <div
      ref={menuRef}
      role="listbox"
      aria-label={t('chat.projectViewBranchFilterAriaLabel')}
      className="fixed z-[9999] overflow-hidden rounded-lg border border-(--divider) bg-(--sidebar-bg) p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]"
      style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
      data-testid="project-branch-view-filter-menu"
    >
      {showSearch && (
        <div className="mb-1 flex items-center gap-2 border-b border-(--divider) px-2 pb-1.5">
          <Search className="h-3.5 w-3.5 text-(--text-muted)" aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('chat.projectViewBranchSearchPlaceholder')}
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-(--sidebar-text-active) outline-none placeholder:text-(--text-muted)"
            data-testid="project-branch-view-filter-search"
          />
        </div>
      )}
      <p className="px-2 pb-1 pt-0.5 text-[0.625rem] font-medium uppercase tracking-[0.08em] text-(--text-muted)">
        {t('chat.projectViewBranchFilterMenuLabel')}
      </p>
      <div className="max-h-72 overflow-y-auto py-0.5">
        <BranchOption label={t('chat.projectViewAllBranches')} selected={!selectedBranch} onChoose={() => choose()} testId="all" />
        {filteredBranches.map((branch) => (
          <BranchOption key={branch} label={branch} selected={selectedBranch === branch} onChoose={() => choose(branch)} testId={branch} />
        ))}
        {filteredBranches.length === 0 && <p className="px-2 py-2 text-xs text-(--text-muted)">{t('chat.projectViewBranchNoMatches')}</p>}
      </div>
    </div>,
    document.body,
  );

  if (compact) {
    return <div className="shrink-0" data-testid="project-branch-view-filter">{trigger}{menu}</div>;
  }

  return (
    <div className="mb-1 flex justify-end px-2.5" data-testid="project-branch-view-filter">
      {trigger}{menu}
    </div>
  );
}

function BranchOption({ label, selected, onChoose, testId }: { label: string; selected: boolean; onChoose: () => void; testId: string }) {
  return (
    <button
      role="option"
      type="button"
      aria-selected={selected}
      onClick={onChoose}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-(--sidebar-text-active) transition-colors',
        'hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
      )}
      data-testid={`project-branch-view-filter-option-${testId}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-(--accent)" aria-hidden="true" />}
    </button>
  );
}
