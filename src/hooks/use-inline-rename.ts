'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

interface UseInlineRenameOptions {
  initialValue: string;
  isRenameRequested?: boolean;
  onRename?: (nextValue: string) => void;
  onRenameComplete?: () => void;
}

interface UseInlineRenameResult {
  inputRef: RefObject<HTMLInputElement | null>;
  isRenaming: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  startRenaming: () => void;
  confirmRename: () => void;
  cancelRename: () => void;
}

export function useInlineRename({
  initialValue,
  isRenameRequested = false,
  onRename,
  onRenameComplete,
}: UseInlineRenameOptions): UseInlineRenameResult {
  const inputRef = useRef<HTMLInputElement>(null);
  const renameSettledRef = useRef(false);
  const previousRequestedRef = useRef(false);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(initialValue);

  useEffect(() => {
    if (isRenameRequested && !previousRequestedRef.current) {
      const frameId = requestAnimationFrame(() => {
        setRenameValue(initialValue);
        setIsRenaming(true);
      });
      previousRequestedRef.current = isRenameRequested;
      return () => cancelAnimationFrame(frameId);
    }
    previousRequestedRef.current = isRenameRequested;
  }, [initialValue, isRenameRequested]);

  useEffect(() => {
    if (!isRenaming || !inputRef.current) return;

    renameSettledRef.current = false;
    inputRef.current.focus();
    inputRef.current.select();
  }, [isRenaming]);

  const finishRename = useCallback(() => {
    setIsRenaming(false);
    onRenameComplete?.();
  }, [onRenameComplete]);

  const startRenaming = useCallback(() => {
    setRenameValue(initialValue);
    setIsRenaming(true);
  }, [initialValue]);

  const confirmRename = useCallback(() => {
    if (renameSettledRef.current) return;
    renameSettledRef.current = true;

    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== initialValue) {
      onRename?.(trimmed);
    }

    finishRename();
  }, [finishRename, initialValue, onRename, renameValue]);

  const cancelRename = useCallback(() => {
    if (renameSettledRef.current) return;
    renameSettledRef.current = true;

    setRenameValue(initialValue);
    finishRename();
  }, [finishRename, initialValue]);

  return {
    inputRef,
    isRenaming,
    renameValue: isRenaming ? renameValue : initialValue,
    setRenameValue,
    startRenaming,
    confirmRename,
    cancelRename,
  };
}
