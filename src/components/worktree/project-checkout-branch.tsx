'use client';

import { Check, ChevronDown, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchWithClientId } from '@/lib/api/fetch-with-client-id';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session-store';
import type { WorktreeBaseRef } from '@/hooks/use-worktree-base-refs';

interface ProjectCheckoutBranchProps {
  worktreeId: string;
  currentBranch: string | null;
}

interface SwitchBranchResponse {
  currentBranch?: string;
  refs?: WorktreeBaseRef[];
  error?: string | { message?: string };
}

function responseError(payload: SwitchBranchResponse, fallback: string): string {
  if (typeof payload.error === 'string') return payload.error;
  return payload.error?.message ?? fallback;
}

export function ProjectCheckoutBranch({
  worktreeId,
  currentBranch,
}: ProjectCheckoutBranchProps) {
  const { t } = useI18n();
  const updateProjectWorktreeBranch = useSessionStore(
    (state) => state.updateProjectWorktreeBranch,
  );
  const [refs, setRefs] = useState<WorktreeBaseRef[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const branchRequestId = useRef(0);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const branchSearchRef = useRef<HTMLInputElement>(null);
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState('');
  const [branchMenuPosition, setBranchMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const loadBranches = useCallback(async () => {
    const requestId = ++branchRequestId.current;
    setIsLoading(true);
    setLoadError(null);
    setRefs([]);
    setSelectedBranch('');
    try {
      const response = await fetchWithClientId(
        `/api/worktrees/${encodeURIComponent(worktreeId)}/branch`,
      );
      const payload = await response.json().catch(() => ({})) as SwitchBranchResponse;
      if (!response.ok || !payload.refs) {
        throw new Error(responseError(payload, t('chat.checkoutBranchSwitchFailed')));
      }
      if (requestId === branchRequestId.current) {
        setRefs(payload.refs);
        setSelectedBranch(payload.refs.find((ref) => ref.current)?.name ?? '');
      }
    } catch (error) {
      if (requestId === branchRequestId.current) {
        setRefs([]);
        setSelectedBranch('');
        setLoadError(error instanceof Error ? error.message : t('chat.checkoutBranchSwitchFailed'));
      }
    } finally {
      if (requestId === branchRequestId.current) setIsLoading(false);
    }
  }, [t, worktreeId]);

  useEffect(() => {
    void loadBranches();
    return () => { branchRequestId.current += 1; };
  }, [loadBranches]);

  useEffect(() => {
    setRefs((currentRefs) => currentRefs.map((ref) => ({
      ...ref,
      current: ref.kind === 'local' && ref.name === currentBranch,
    })));
  }, [currentBranch]);

  const localRefs = useMemo(
    () => refs.filter((ref) => ref.kind === 'local'),
    [refs],
  );
  const matchingLocalRefs = useMemo(() => {
    const query = branchQuery.trim().toLocaleLowerCase();
    return query ? localRefs.filter((ref) => ref.name.toLocaleLowerCase().includes(query)) : localRefs;
  }, [branchQuery, localRefs]);

  useEffect(() => {
    if (!isBranchMenuOpen) return;
    const updatePosition = () => {
      const rect = branchTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 300);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
      const estimatedHeight = Math.min(matchingLocalRefs.length, 8) * 36 + 62;
      const top = rect.bottom + 4 + estimatedHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - estimatedHeight - 4)
        : rect.bottom + 4;
      setBranchMenuPosition({ top, left, width });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isBranchMenuOpen, matchingLocalRefs.length]);

  useEffect(() => {
    if (!isBranchMenuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!branchMenuRef.current?.contains(target) && !branchTriggerRef.current?.contains(target)) setIsBranchMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsBranchMenuOpen(false);
        branchTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isBranchMenuOpen]);

  useEffect(() => {
    if (isBranchMenuOpen) branchSearchRef.current?.focus();
  }, [isBranchMenuOpen]);
  const canSwitch = Boolean(
    selectedBranch
      && selectedBranch !== currentBranch
      && localRefs.some((ref) => ref.name === selectedBranch)
      && !isLoading
      && !isSwitching,
  );

  async function handleSwitch() {
    if (!canSwitch) return;
    setIsSwitching(true);
    setSwitchError(null);
    try {
      const response = await fetchWithClientId(
        `/api/worktrees/${encodeURIComponent(worktreeId)}/branch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: selectedBranch }),
        },
      );
      const payload = await response.json().catch(() => ({})) as SwitchBranchResponse;
      if (!response.ok || !payload.currentBranch) {
        throw new Error(responseError(payload, t('chat.checkoutBranchSwitchFailed')));
      }
      if (payload.refs) setRefs(payload.refs);
      else {
        setRefs((currentRefs) => currentRefs.map((ref) => ({
          ...ref,
          current: ref.kind === 'local' && ref.name === payload.currentBranch,
        })));
      }
      setSelectedBranch(payload.currentBranch);
      updateProjectWorktreeBranch(worktreeId, payload.currentBranch);
    } catch (error) {
      setSwitchError(
        error instanceof Error ? error.message : t('chat.checkoutBranchSwitchFailed'),
      );
    } finally {
      setIsSwitching(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="project-checkout-branch">
      <label className="block text-xs font-medium uppercase tracking-wide text-(--text-muted)">
        {t('chat.checkoutBranchLabel')}
      </label>
      <div className="flex gap-2">
        <button
          ref={branchTriggerRef}
          type="button"
          aria-label={t('chat.checkoutBranchAriaLabel')}
          aria-haspopup="listbox"
          aria-expanded={isBranchMenuOpen}
          onClick={() => {
            setIsBranchMenuOpen((open) => !open);
            setSwitchError(null);
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md border border-(--divider) bg-(--chat-bg) px-3 py-2 font-mono text-sm text-(--text-primary) outline-none transition-colors',
            'hover:border-(--text-muted) focus:border-(--accent)',
            isBranchMenuOpen && 'border-(--accent)',
          )}
          disabled={isLoading || isSwitching || localRefs.length === 0}
          data-testid="project-checkout-branch-trigger"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedBranch
              ? `${selectedBranch}${selectedBranch === currentBranch ? ` (${t('chat.checkoutBranchCurrent')})` : ''}`
              : (isLoading ? t('chat.checkoutBranchLoading') : t('chat.checkoutBranchUnavailable'))}
          </span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', isBranchMenuOpen && 'rotate-180')} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => { void handleSwitch(); }}
          disabled={!canSwitch}
          className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-md bg-(--accent) px-3 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="project-checkout-branch-submit"
        >
          {isSwitching && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {isSwitching
            ? t('chat.checkoutBranchSwitching')
            : t('chat.checkoutBranchAction')}
        </button>
      </div>
      {isBranchMenuOpen && branchMenuPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={branchMenuRef}
          role="listbox"
          aria-label={t('chat.checkoutBranchAriaLabel')}
          className="fixed z-[10000] overflow-hidden rounded-lg border border-(--divider) bg-(--chat-bg) p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.32)]"
          style={branchMenuPosition}
          data-testid="project-checkout-branch-menu"
        >
          <div className="mb-1 flex items-center gap-2 border-b border-(--divider) px-2 pb-1.5">
            <Search className="h-4 w-4 text-(--text-muted)" aria-hidden="true" />
            <input
              ref={branchSearchRef}
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
              placeholder={t('chat.checkoutBranchSearchPlaceholder')}
              className="h-8 min-w-0 flex-1 bg-transparent font-mono text-sm text-(--text-primary) outline-none placeholder:font-sans placeholder:text-(--text-muted)"
              data-testid="project-checkout-branch-search"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-0.5">
            {matchingLocalRefs.map((ref) => {
              const isSelected = ref.name === selectedBranch;
              return (
                <button
                  key={ref.name}
                  role="option"
                  type="button"
                  aria-selected={isSelected}
                  onClick={() => {
                    setSelectedBranch(ref.name);
                    setBranchQuery('');
                    setSwitchError(null);
                    setIsBranchMenuOpen(false);
                    branchTriggerRef.current?.focus();
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-sm text-(--text-primary) hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none"
                  data-testid={`project-checkout-branch-option-${ref.name}`}
                >
                  <span className="min-w-0 flex-1 truncate">{ref.name}</span>
                  {ref.current && <span className="font-sans text-[0.6875rem] text-(--text-muted)">{t('chat.checkoutBranchCurrent')}</span>}
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-(--accent)" aria-hidden="true" />}
                </button>
              );
            })}
            {matchingLocalRefs.length === 0 && <p className="px-2 py-3 text-sm text-(--text-muted)">{t('chat.checkoutBranchNoMatches')}</p>}
          </div>
        </div>,
        document.body,
      )}
      {(loadError || switchError) && (
        <p className="text-xs text-(--error)" role="alert">
          {switchError ?? loadError}
        </p>
      )}
    </div>
  );
}
