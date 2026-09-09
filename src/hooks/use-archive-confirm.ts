'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_ARCHIVE_CONFIRM_SCOPE = '';

export function isArchiveConfirmationArmed(
  armedScopeKey: string | null,
  currentScopeKey?: string | null,
): boolean {
  return armedScopeKey !== null
    && armedScopeKey === (currentScopeKey ?? DEFAULT_ARCHIVE_CONFIRM_SCOPE);
}

export function useArchiveConfirm(
  onConfirm: () => void,
  timeoutMs = 3000,
  scopeKey?: string | null,
) {
  const [armedScopeKey, setArmedScopeKey] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const resolvedScopeKey = scopeKey ?? DEFAULT_ARCHIVE_CONFIRM_SCOPE;
  const isConfirmingArchive = isArchiveConfirmationArmed(armedScopeKey, scopeKey);

  const clearConfirmTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const resetArchiveConfirm = useCallback(() => {
    clearConfirmTimeout();
    setArmedScopeKey(null);
  }, [clearConfirmTimeout]);

  const armArchiveConfirm = useCallback(() => {
    clearConfirmTimeout();
    setArmedScopeKey(resolvedScopeKey);
    timeoutRef.current = window.setTimeout(() => {
      setArmedScopeKey(null);
      timeoutRef.current = null;
    }, timeoutMs);
  }, [clearConfirmTimeout, resolvedScopeKey, timeoutMs]);

  const handleArchiveClick = useCallback(() => {
    if (isConfirmingArchive) {
      resetArchiveConfirm();
      onConfirm();
      return;
    }
    armArchiveConfirm();
  }, [armArchiveConfirm, isConfirmingArchive, onConfirm, resetArchiveConfirm]);

  useEffect(() => resetArchiveConfirm, [resetArchiveConfirm]);

  return {
    isConfirmingArchive,
    handleArchiveClick,
    resetArchiveConfirm,
  };
}
