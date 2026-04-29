'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useSessionStore } from '@/stores/session-store';
import { useNotificationStore } from '@/stores/notification-store';
import { SESSION_DRAG_MIME } from '@/types/panel';
import type { SessionRefItem } from '@/types/session-ref';
import { SESSION_REF_PLACEHOLDER_REGEX, MAX_SESSION_REFS } from '@/types/session-ref';
import { useI18n } from '@/lib/i18n';
import { exportSessionReference, formatSessionReference } from '@/lib/session/session-reference';

interface UseSessionRefsOptions {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInputValue: (value: string) => void;
  getInputValue: () => string;
}

interface DroppedSessionRef {
  sessionId: string;
  title: string;
  kind: 'chat' | 'task';
}

export interface UseSessionRefsReturn {
  refs: SessionRefItem[];
  isDragOver: boolean;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
  removeRef: (slot: number) => void;
  retryRef: (slot: number) => void;
  syncRefsWithText: (text: string) => void;
  resolveRefs: (rawText: string) => string;
  validateRefsReady: (rawText: string) => boolean;
  clearRefs: () => void;
  hasRefs: boolean;
  /**
   * Programmatically add a session reference (e.g. from the @-mention picker).
   * Inserts a placeholder at the current textarea cursor after the session
   * export resolves. Silently no-ops if validation fails (e.g. duplicate or
   * MAX_SESSION_REFS exceeded — a toast is shown in those cases).
   */
  addSessionRef: (sessionId: string, kind?: 'chat' | 'task') => void;
}

export function useSessionRefs({
  textareaRef,
  setInputValue,
  getInputValue,
}: UseSessionRefsOptions): UseSessionRefsReturn {
  const { t } = useI18n();
  const [refs, setRefs] = useState<SessionRefItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const slotCounterRef = useRef<number>(0);
  const dragCounterRef = useRef(0);
  const refsRef = useRef<SessionRefItem[]>([]);

  const updateRefs = useCallback((updater: (prev: SessionRefItem[]) => SessionRefItem[]) => {
    const next = updater(refsRef.current);
    refsRef.current = next;
    setRefs(next);
  }, []);

  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);

  const isSessionRefDragEvent = useCallback((event: React.DragEvent) => {
    return event.dataTransfer.types.includes(SESSION_DRAG_MIME);
  }, []);

  const clearDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
  }, []);

  const insertRefPlaceholderAtCursor = useCallback((slot: number) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const placeholder = `[📎 ${slot}]`;
    const cursorPos = textarea.selectionStart;
    // Read directly from the DOM so we always see the latest value —
    // getInputValue() is closure-captured and can be stale when this
    // runs after an async boundary (e.g. export → .then → insert).
    const currentValue = textarea.value;
    const nextValue = currentValue.slice(0, cursorPos) + placeholder + currentValue.slice(cursorPos);

    setInputValue(nextValue);

    requestAnimationFrame(() => {
      const nextCursorPos = cursorPos + placeholder.length;
      textarea.setSelectionRange(nextCursorPos, nextCursorPos);
      textarea.focus();
    });
  }, [setInputValue, textareaRef]);

  const validateDroppedSessionRef = useCallback(
    (sessionId: string, kindHint?: 'chat' | 'task'): DroppedSessionRef | null => {
      const currentRefs = refsRef.current;

      if (currentRefs.length >= MAX_SESSION_REFS) {
        useNotificationStore.getState().showToast(
          t('validation.maxSessionRefsExceeded', { max: MAX_SESSION_REFS }),
          'error',
        );
        return null;
      }

      if (currentRefs.some((ref) => ref.sessionId === sessionId)) {
        return null;
      }

      const session = useSessionStore.getState().getSession(sessionId);
      const kind: 'chat' | 'task' = kindHint ?? (session?.taskId ? 'task' : 'chat');
      return {
        sessionId,
        title: session?.title ?? sessionId.slice(0, 8),
        kind,
      };
    },
    [t],
  );

  const startExportForRef = useCallback((slot: number, sessionId: string) => {
    exportSessionReference(sessionId)
      .then((exportPath) => {
        updateRefs((prev) => prev.map((ref) =>
          ref.slot === slot
            ? { ...ref, status: 'ready', exportPath }
            : ref
        ));
      })
      .catch(() => {
        updateRefs((prev) => prev.map((ref) =>
          ref.slot === slot
            ? { ...ref, status: 'error', exportPath: undefined }
            : ref
        ));
        useNotificationStore.getState().showToast(
          t('errors.sessionExportFailed'),
          'error',
        );
      });
  }, [t, updateRefs]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isSessionRefDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, [isSessionRefDragEvent]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isSessionRefDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  }, [isSessionRefDragEvent]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isSessionRefDragEvent(e)) return;
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      clearDragState();
    }
  }, [clearDragState, isSessionRefDragEvent]);

  const addSessionRef = useCallback((sessionId: string, kind?: 'chat' | 'task') => {
    const droppedRef = validateDroppedSessionRef(sessionId, kind);
    if (!droppedRef) return;

    const newSlot = ++slotCounterRef.current;
    const optimisticRef: SessionRefItem = {
      slot: newSlot,
      sessionId: droppedRef.sessionId,
      title: droppedRef.title,
      kind: droppedRef.kind,
      status: 'pending',
    };

    insertRefPlaceholderAtCursor(newSlot);
    updateRefs((prev) => [...prev, optimisticRef]);

    // Export in the background so the drop interaction completes immediately.
    startExportForRef(newSlot, droppedRef.sessionId);
  }, [insertRefPlaceholderAtCursor, startExportForRef, updateRefs, validateDroppedSessionRef]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isSessionRefDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();

    clearDragState();

    const sessionId = e.dataTransfer.getData(SESSION_DRAG_MIME);
    if (!sessionId) return;

    addSessionRef(sessionId);
  }, [addSessionRef, clearDragState, isSessionRefDragEvent]);

  const removeRef = useCallback((slot: number) => {
    updateRefs(prev => prev.filter(r => r.slot !== slot));

    const placeholder = `[📎 ${slot}]`;
    const currentValue = getInputValue();
    const newValue = currentValue.split(placeholder).join('');
    setInputValue(newValue);
  }, [getInputValue, setInputValue, updateRefs]);

  const retryRef = useCallback((slot: number) => {
    const ref = refsRef.current.find((item) => item.slot === slot);
    if (!ref || ref.status === 'pending') {
      return;
    }

    updateRefs((prev) => prev.map((item) =>
      item.slot === slot
        ? { ...item, status: 'pending', exportPath: undefined }
        : item
    ));
    startExportForRef(slot, ref.sessionId);
  }, [startExportForRef, updateRefs]);

  const syncRefsWithText = useCallback((text: string) => {
    const regex = new RegExp(SESSION_REF_PLACEHOLDER_REGEX.source, 'g');
    const existingSlots = new Set<number>();
    let match;
    while ((match = regex.exec(text)) !== null) {
      existingSlots.add(Number(match[1]));
    }

    updateRefs(prev => {
      const toRemove = prev.filter(r => !existingSlots.has(r.slot));
      if (toRemove.length === 0) return prev;
      return prev.filter(r => existingSlots.has(r.slot));
    });
  }, [updateRefs]);

  const validateRefsReady = useCallback((rawText: string): boolean => {
    const snapshot = refsRef.current;
    if (snapshot.length === 0) return true;

    const activeRefs = snapshot.filter((ref) => rawText.includes(`[📎 ${ref.slot}]`));
    const pendingRef = activeRefs.find((ref) => ref.status === 'pending');
    if (pendingRef) {
      useNotificationStore.getState().showToast(
        t('errors.sessionRefPreparing'),
        'warning',
      );
      return false;
    }

    const failedRef = activeRefs.find((ref) => ref.status === 'error' || !ref.exportPath);
    if (failedRef) {
      useNotificationStore.getState().showToast(
        t('errors.sessionRefUnavailable'),
        'error',
      );
      return false;
    }

    return true;
  }, [t]);

  // Synchronous — exportPath is resolved asynchronously before send.
  const resolveRefs = useCallback((rawText: string): string => {
    const snapshot = refsRef.current;
    if (snapshot.length === 0) return rawText;

    let resolvedText = rawText;
    for (const ref of snapshot) {
      const placeholder = `[📎 ${ref.slot}]`;
      if (ref.status !== 'ready' || !ref.exportPath) {
        continue;
      }
      resolvedText = resolvedText.replace(
        placeholder,
        formatSessionReference(ref.title, ref.exportPath)
      );
    }
    return resolvedText;
  }, []);

  const clearRefs = useCallback(() => {
    updateRefs(() => []);
  }, [updateRefs]);

  return {
    refs,
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeRef,
    retryRef,
    syncRefsWithText,
    resolveRefs,
    validateRefsReady,
    clearRefs,
    hasRefs: refs.length > 0,
    addSessionRef,
  };
}
