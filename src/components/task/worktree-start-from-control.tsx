'use client';

import { useMemo } from 'react';
import type {
  WorktreeBaseRef,
  WorktreeCreationMode,
} from '@/hooks/use-worktree-base-refs';
import { useI18n } from '@/lib/i18n';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

interface WorktreeStartFromControlProps {
  id: string;
  testId: string;
  refs: WorktreeBaseRef[];
  creationMode: WorktreeCreationMode;
  selectedBaseRef: string;
  isLoading: boolean;
  error: string | null;
  disabled?: boolean;
  compact?: boolean;
  onCreationModeChange: (mode: WorktreeCreationMode) => void;
  onSelectedBaseRefChange: (value: string) => void;
}

export function WorktreeStartFromControl({
  id,
  testId,
  refs,
  creationMode,
  selectedBaseRef,
  isLoading,
  error,
  disabled = false,
  compact = false,
  onCreationModeChange,
  onSelectedBaseRefChange,
}: WorktreeStartFromControlProps) {
  const { t } = useI18n();
  const localRefs = useMemo(() => refs.filter((ref) => ref.kind === 'local'), [refs]);
  const remoteRefs = useMemo(() => refs.filter((ref) => ref.kind === 'remote'), [refs]);
  const otherRefs = useMemo(
    () => refs.filter((ref) => ref.kind !== 'local' && ref.kind !== 'remote'),
    [refs],
  );
  const selectDisabled = disabled || isLoading || refs.length === 0;
  const sourceModeId = `${id}-source-mode`;
  const errorId = `${id}-error`;
  const selectClassName = cn(
    'min-w-0 w-full border border-(--divider) bg-(--input-bg) text-(--sidebar-text-active) outline-none transition-colors focus:border-(--accent) disabled:cursor-not-allowed disabled:opacity-60',
    compact
      ? 'rounded-lg px-2.5 py-1.5 text-[13px]'
      : 'max-w-md rounded-xl px-3 py-2.5 text-sm',
  );

  return (
    <div className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-2')}>
      <label
        htmlFor={sourceModeId}
        className={cn(
          'font-semibold uppercase tracking-[0.08em] text-(--text-muted)',
          compact ? 'text-[9px]' : 'text-[10px]',
        )}
      >
        {t('task.creation.worktreeSourceLabel')}
      </label>
      <Select
        {...telemetryClickAttributes('creation.worktree.source', 'new_session')}
        id={sourceModeId}
        value={creationMode}
        onValueChange={(value) => onCreationModeChange(value as WorktreeCreationMode)}
        disabled={disabled}
        className={selectClassName}
        data-testid={`${testId}-source-mode`}
        options={[
          { value: 'branch-off', label: t('task.creation.worktreeSourceBranchOff') },
          { value: 'checkout-branch', label: t('task.creation.worktreeSourceCheckout') },
        ]}
      />
      <label
        htmlFor={id}
        className={cn(
          'font-semibold uppercase tracking-[0.08em] text-(--text-muted)',
          compact ? 'text-[9px]' : 'text-[10px]',
        )}
      >
        {creationMode === 'checkout-branch'
          ? t('task.creation.checkoutBranchLabel')
          : t('task.creation.baseRefLabel')}
      </label>
      <Select
        {...telemetryClickAttributes('creation.worktree.base_ref', 'new_session')}
        id={id}
        value={selectedBaseRef}
        onValueChange={onSelectedBaseRefChange}
        disabled={selectDisabled}
        className={selectClassName}
        aria-describedby={error ? errorId : undefined}
        data-testid={testId}
        placeholder={isLoading ? t('task.creation.baseRefLoading') : creationMode === 'checkout-branch' ? t('task.creation.checkoutBranchUnavailable') : t('task.creation.baseRefUnavailable')}
        searchPlaceholder={t('chat.checkoutBranchSearchPlaceholder')}
        emptyLabel={t('chat.checkoutBranchNoMatches')}
        options={[
          ...localRefs.map((ref) => ({ value: ref.name, label: formatBaseRefLabel(ref, t('task.creation.baseRefCurrentSuffix')), group: t('task.creation.baseRefLocalGroup') })),
          ...remoteRefs.map((ref) => ({ value: ref.name, label: formatBaseRefLabel(ref, t('task.creation.baseRefCurrentSuffix')), group: t('task.creation.baseRefRemoteGroup') })),
          ...otherRefs.map((ref) => ({ value: ref.name, label: formatBaseRefLabel(ref, t('task.creation.baseRefCurrentSuffix')) })),
        ]}
      />
      {error ? (
        <p
          id={errorId}
          className={cn('truncate px-1 text-(--text-muted)', compact ? 'text-[9px]' : 'text-[11px]')}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function formatBaseRefLabel(ref: WorktreeBaseRef, currentSuffix: string): string {
  return ref['current'] ? `${ref.label} (${currentSuffix})` : ref.label;
}
