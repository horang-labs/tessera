'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useArchiveConfirm(onConfirm: () => void, timeoutMs = 3000) {
  const [isConfirmingArchive, setIsConfirmingArchive] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const clearConfirmTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const resetArchiveConfirm = useCallback(() => {
    clearConfirmTimeout();
    setIsConfirmingArchive(false);
  }, [clearConfirmTimeout]);

  const armArchiveConfirm = useCallback(() => {
    clearConfirmTimeout();
    setIsConfirmingArchive(true);
    timeoutRef.current = window.setTimeout(() => {
      setIsConfirmingArchive(false);
      timeoutRef.current = null;
    }, timeoutMs);
  }, [clearConfirmTimeout, timeoutMs]);

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
