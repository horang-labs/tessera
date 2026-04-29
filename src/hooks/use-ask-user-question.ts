'use client';

import { useState, useCallback, useMemo, useRef } from 'react';
import type { AskUserQuestionItem, AskUserQuestionOption } from '@/types/cli-jsonl-schemas';
import { useWebSocket } from '@/hooks/use-websocket';
import { i18n } from '@/lib/i18n';

// ========== Constants ==========

export const OTHER_OPTION_LABEL = '__other__';
const OTHER_LABELS = ['other', 'others', '기타', 'custom', 'other (specify)'];
const MAX_RETRY = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

// ========== Types ==========

export interface ProcessedOption extends AskUserQuestionOption {
  isOther: boolean;
}

export interface QuestionSelectionState {
  selectedLabels: Set<string>;
  otherText: string;
  otherSelected: boolean;
  annotationNote: string;
  annotationOpen: boolean;
  hoveredLabel: string | null;
}

export type SubmissionState = 'pending' | 'submitting' | 'submitted' | 'error';

// ========== Utility Functions (exported for testing) ==========

/**
 * Process raw options: detect "Other" options and auto-append if missing.
 * Only marks the first matching "Other" option as isOther.
 */
export function processOptions(rawOptions: AskUserQuestionOption[]): ProcessedOption[] {
  let firstOtherMarked = false;

  const result: ProcessedOption[] = rawOptions.map((opt) => {
    const isOther = !firstOtherMarked && OTHER_LABELS.some(keyword =>
      opt.label.toLowerCase().includes(keyword)
    );
    if (isOther) firstOtherMarked = true;
    return { ...opt, isOther };
  });

  if (!firstOtherMarked) {
    result.push({
      label: i18n.t('chat.otherOption'),
      description: i18n.t('chat.otherOptionDesc'),
      isOther: true,
    });
  }

  return result;
}

/**
 * Get the key used to identify an option in selection state.
 * "Other" options use a special constant key; others use their label.
 */
export function getOptionKey(opt: ProcessedOption): string {
  return opt.isOther ? OTHER_OPTION_LABEL : opt.label;
}

/**
 * Return a deduplicated header key for use in serialized JSON.
 * If the same header appears multiple times, suffixes _1, _2, etc. are appended.
 */
export function deduplicateHeader(
  header: string,
  currentIdx: number,
  questions: AskUserQuestionItem[]
): string {
  // Count occurrences of the same header before currentIdx
  let count = 0;
  for (let i = 0; i < currentIdx; i++) {
    if (questions[i].header === header) {
      count++;
    }
  }
  return count === 0 ? header : `${header}_${count}`;
}

/**
 * Serialize all question responses to a string for submission.
 * Simple case (1 question, single-select, no annotations): plain string
 * Complex case: JSON object with header keys
 */
export function serializeResponse(
  questions: AskUserQuestionItem[],
  questionStates: Map<number, QuestionSelectionState>
): string {
  const hasAnnotations = [...questionStates.values()].some(s => s.annotationNote.trim() !== '');

  // Simple case: single question, single select, no annotations
  if (questions.length === 1 && !questions[0].multiSelect && !hasAnnotations) {
    const state = questionStates.get(0)!;
    if (state.otherSelected) return state.otherText.trim();
    const [selected] = state.selectedLabels;
    return selected ?? '';
  }

  // Complex case: JSON object
  const result: Record<string, unknown> = {};

  questions.forEach((q, idx) => {
    const state = questionStates.get(idx)!;
    const key = deduplicateHeader(q.header, idx, questions);

    if (q.multiSelect) {
      const values: string[] = [];
      for (const label of state.selectedLabels) {
        if (label !== OTHER_OPTION_LABEL) values.push(label);
      }
      if (state.otherSelected && state.otherText.trim()) {
        values.push(state.otherText.trim());
      }
      result[key] = values;
    } else {
      if (state.otherSelected) {
        result[key] = state.otherText.trim();
      } else {
        const [selected] = state.selectedLabels;
        result[key] = selected ?? '';
      }
    }
  });

  // Annotations
  if (hasAnnotations) {
    const annotations: Record<string, { notes: string }> = {};
    questions.forEach((q, idx) => {
      const state = questionStates.get(idx)!;
      if (state.annotationNote.trim()) {
        annotations[q.question] = { notes: state.annotationNote.trim() };
      }
    });
    result['__annotations'] = annotations;
  }

  return JSON.stringify(result);
}

/**
 * Parse a serialized response string back into per-question selected label sets.
 * Inverse of serializeResponse for read-only rendering.
 */
export function parseSubmittedAnswers(
  serialized: string,
  questions: AskUserQuestionItem[]
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();

  // Initialize empty sets
  questions.forEach((_, idx) => {
    result.set(idx, new Set<string>());
  });

  if (!serialized) return result;

  // Try to parse as JSON
  let parsed: Record<string, unknown> | null = null;
  try {
    const maybeObj = JSON.parse(serialized);
    if (typeof maybeObj === 'object' && maybeObj !== null && !Array.isArray(maybeObj)) {
      parsed = maybeObj as Record<string, unknown>;
    }
  } catch {
    // Not JSON — treat as plain string (simple single-question answer)
  }

  if (!parsed) {
    // Plain string: single question answer
    if (questions.length > 0) {
      result.set(0, new Set([serialized]));
    }
    return result;
  }

  // JSON object: match headers to question indices
  questions.forEach((q, idx) => {
    const key = deduplicateHeader(q.header, idx, questions);
    const value = parsed![key];
    if (value === undefined) return;

    const set = new Set<string>();
    if (Array.isArray(value)) {
      value.forEach(v => { if (typeof v === 'string') set.add(v); });
    } else if (typeof value === 'string') {
      set.add(value);
    }
    result.set(idx, set);
  });

  return result;
}

// ========== Hook ==========

interface UseAskUserQuestionProps {
  questions: AskUserQuestionItem[];
  toolUseId: string;
  sessionId: string;
}

interface UseAskUserQuestionReturn {
  // State
  questionStates: Map<number, QuestionSelectionState>;
  submissionState: SubmissionState;
  errorRetryCount: number;
  processedOptionsMap: Map<number, ProcessedOption[]>;  // memoized

  // Derived
  isAllAnswered: boolean;
  unansweredIndices: number[];

  // Actions
  toggleOption: (questionIdx: number, label: string) => void;
  setOtherText: (questionIdx: number, text: string) => void;
  setAnnotationNote: (questionIdx: number, note: string) => void;
  toggleAnnotation: (questionIdx: number) => void;
  setHoveredLabel: (questionIdx: number, label: string | null) => void;
  submit: () => Promise<void>;
  retrySubmit: () => Promise<void>;
}

export function useAskUserQuestion({
  questions,
  toolUseId,
  sessionId,
}: UseAskUserQuestionProps): UseAskUserQuestionReturn {
  const { sendInteractiveResponse } = useWebSocket();
  const [submissionState, setSubmissionState] = useState<SubmissionState>('pending');
  const [errorRetryCount, setErrorRetryCount] = useState(0);
  const cachedResponseRef = useRef<string>('');

  // Initialize question states
  const [questionStates, setQuestionStates] = useState<Map<number, QuestionSelectionState>>(() => {
    const map = new Map<number, QuestionSelectionState>();
    questions.forEach((_, idx) => {
      map.set(idx, {
        selectedLabels: new Set(),
        otherText: '',
        otherSelected: false,
        annotationNote: '',
        annotationOpen: false,
        hoveredLabel: null,
      });
    });
    return map;
  });

  // Memoized processed options (with Other detection)
  const processedOptionsMap = useMemo(() => {
    const map = new Map<number, ProcessedOption[]>();
    questions.forEach((q, idx) => {
      map.set(idx, processOptions(q.options));
    });
    return map;
  }, [questions]);

  // isQuestionAnswered helper
  const isQuestionAnswered = useCallback((idx: number): boolean => {
    const state = questionStates.get(idx);
    if (!state) return false;
    const q = questions[idx];

    if (q.multiSelect) {
      if (state.selectedLabels.size === 0 && !state.otherSelected) return false;
      if (state.otherSelected && !state.otherText.trim()) return false;
      return state.selectedLabels.size > 0 || (state.otherSelected && !!state.otherText.trim());
    } else {
      if (state.otherSelected) return !!state.otherText.trim();
      return state.selectedLabels.size === 1;
    }
  }, [questionStates, questions]);

  const isAllAnswered = useMemo(() =>
    questions.every((_, idx) => isQuestionAnswered(idx)),
    [questions, isQuestionAnswered]
  );

  const unansweredIndices = useMemo(() =>
    questions.map((_, idx) => idx).filter(idx => !isQuestionAnswered(idx)),
    [questions, isQuestionAnswered]
  );

  // toggleOption: handles single-select (radio) and multi-select (checkbox) logic
  const toggleOption = useCallback((questionIdx: number, label: string) => {
    setQuestionStates(prev => {
      const newMap = new Map(prev);
      const state = { ...prev.get(questionIdx)! };
      const q = questions[questionIdx];
      const isOther = label === OTHER_OPTION_LABEL;

      if (q.multiSelect) {
        if (isOther) {
          state.otherSelected = !state.otherSelected;
        } else {
          const newLabels = new Set(state.selectedLabels);
          if (newLabels.has(label)) newLabels.delete(label);
          else newLabels.add(label);
          state.selectedLabels = newLabels;
        }
      } else {
        // Single select: toggle or switch
        const alreadySelected = isOther ? state.otherSelected : state.selectedLabels.has(label);
        if (alreadySelected) {
          state.selectedLabels = new Set();
          state.otherSelected = false;
        } else {
          state.selectedLabels = isOther ? new Set() : new Set([label]);
          state.otherSelected = isOther;
        }
      }

      newMap.set(questionIdx, state);
      return newMap;
    });
  }, [questions]);

  const setOtherText = useCallback((questionIdx: number, text: string) => {
    setQuestionStates(prev => {
      const newMap = new Map(prev);
      const state = { ...prev.get(questionIdx)! };
      state.otherText = text;
      newMap.set(questionIdx, state);
      return newMap;
    });
  }, []);

  const setAnnotationNote = useCallback((questionIdx: number, note: string) => {
    setQuestionStates(prev => {
      const newMap = new Map(prev);
      const state = { ...prev.get(questionIdx)! };
      state.annotationNote = note;
      newMap.set(questionIdx, state);
      return newMap;
    });
  }, []);

  const toggleAnnotation = useCallback((questionIdx: number) => {
    setQuestionStates(prev => {
      const newMap = new Map(prev);
      const state = { ...prev.get(questionIdx)! };
      state.annotationOpen = !state.annotationOpen;
      newMap.set(questionIdx, state);
      return newMap;
    });
  }, []);

  const setHoveredLabel = useCallback((questionIdx: number, label: string | null) => {
    setQuestionStates(prev => {
      const newMap = new Map(prev);
      const state = { ...prev.get(questionIdx)! };
      state.hoveredLabel = label;
      newMap.set(questionIdx, state);
      return newMap;
    });
  }, []);

  // submit() with exponential backoff retry
  const submit = useCallback(async () => {
    if (!isAllAnswered || submissionState === 'submitting') return;

    const serialized = serializeResponse(questions, questionStates);
    cachedResponseRef.current = serialized;
    setSubmissionState('submitting');
    setErrorRetryCount(0);

    let retryCount = 0;
    while (retryCount <= MAX_RETRY) {
      const sent = sendInteractiveResponse(sessionId, toolUseId, serialized);
      if (sent) {
        setSubmissionState('submitted');
        return;
      }
      retryCount++;
      setErrorRetryCount(retryCount);
      if (retryCount > MAX_RETRY) {
        setSubmissionState('error');
        return;
      }
      setSubmissionState('error');
      await new Promise(r => setTimeout(r, RETRY_DELAYS[retryCount - 1]));
    }
  }, [isAllAnswered, submissionState, questions, questionStates, sessionId, toolUseId, sendInteractiveResponse]);

  // retrySubmit() uses cached response to avoid recomputing
  const retrySubmit = useCallback(async () => {
    const serialized = cachedResponseRef.current || serializeResponse(questions, questionStates);
    setSubmissionState('submitting');
    const sent = sendInteractiveResponse(sessionId, toolUseId, serialized);
    if (sent) {
      setSubmissionState('submitted');
    } else {
      setSubmissionState('error');
    }
  }, [questions, questionStates, sessionId, toolUseId, sendInteractiveResponse]);

  return {
    questionStates,
    submissionState,
    errorRetryCount,
    processedOptionsMap,
    isAllAnswered,
    unansweredIndices,
    toggleOption,
    setOtherText,
    setAnnotationNote,
    toggleAnnotation,
    setHoveredLabel,
    submit,
    retrySubmit,
  };
}
