'use client';

import { useMemo } from 'react';
import type {
  WorktreeBaseRef,
  WorktreeCreationMode,
} from '@/hooks/use-worktree-base-refs';
import { useI18n } from '@/lib/i18n';
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
      <select
        {...telemetryClickAttributes('creation.worktree.source', 'new_session')}
        id={sourceModeId}
        value={creationMode}
        onChange={(event) => onCreationModeChange(event.target.value as WorktreeCreationMode)}
        disabled={disabled}
        className={selectClassName}
        data-testid={`${testId}-source-mode`}
      >
        <option value="branch-off">{t('task.creation.worktreeSourceBranchOff')}</option>
        <option value="checkout-branch">{t('task.creation.worktreeSourceCheckout')}</option>
      </select>
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
      <select
        {...telemetryClickAttributes('creation.worktree.base_ref', 'new_session')}
        id={id}
        value={selectedBaseRef}
        onChange={(event) => onSelectedBaseRefChange(event.target.value)}
        disabled={selectDisabled}
        className={selectClassName}
        aria-describedby={error ? errorId : undefined}
        data-testid={testId}
      >
        {isLoading ? (
          <option value="">{t('task.creation.baseRefLoading')}</option>
        ) : refs.length === 0 ? (
          <option value="">
            {creationMode === 'checkout-branch'
              ? t('task.creation.checkoutBranchUnavailable')
              : t('task.creation.baseRefUnavailable')}
          </option>
        ) : (
          <>
            {localRefs.length > 0 ? (
              <optgroup label={t('task.creation.baseRefLocalGroup')}>
                {localRefs.map((ref) => (
                  <option key={ref.name} value={ref.name}>
                    {formatBaseRefLabel(ref, t('task.creation.baseRefCurrentSuffix'))}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {remoteRefs.length > 0 ? (
              <optgroup label={t('task.creation.baseRefRemoteGroup')}>
                {remoteRefs.map((ref) => (
                  <option key={ref.name} value={ref.name}>
                    {formatBaseRefLabel(ref, t('task.creation.baseRefCurrentSuffix'))}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {otherRefs.map((ref) => (
              <option key={ref.name} value={ref.name}>
                {formatBaseRefLabel(ref, t('task.creation.baseRefCurrentSuffix'))}
              </option>
            ))}
          </>
        )}
      </select>
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
