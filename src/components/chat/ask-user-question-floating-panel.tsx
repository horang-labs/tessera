'use client';

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { MessageCircleQuestion, Send, Loader2, RefreshCw, FileCode2, Minus, Plus } from 'lucide-react';
import type { AskUserQuestionItem } from '@/types/cli-jsonl-schemas';
import {
  useAskUserQuestion,
  processOptions,
  getOptionKey,
} from '@/hooks/use-ask-user-question';
import { useWebSocket } from '@/hooks/use-websocket';
import { usePanelStore, selectActiveTab } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import {
  usePromptDensityStore,
  promptDensityVars,
  PROMPT_DENSITY_ORDER,
} from '@/stores/prompt-density-store';
import { PreviewMarkdown } from './preview-markdown';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ProviderLogoMark, getProviderBrand } from './provider-brand';

/** Sentinel value to signal decline (deny) instead of answering */
export const DECLINE_SENTINEL = '__DECLINE__';

interface AskUserQuestionFloatingPanelProps {
  questions: AskUserQuestionItem[];
  toolUseId: string;
  sessionId: string;
  metadata?: { source?: string };
}

export function AskUserQuestionFloatingPanel({
  questions,
  toolUseId,
  sessionId,
}: AskUserQuestionFloatingPanelProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { sendInteractiveResponse } = useWebSocket();
  const providerId = useSessionStore((state) => state.getSession(sessionId)?.provider);
  const providerBrand = getProviderBrand(providerId);

  const density = usePromptDensityStore((s) => s.density);
  const stepDensity = usePromptDensityStore((s) => s.stepDensity);
  const densityIdx = PROMPT_DENSITY_ORDER.indexOf(density);
  const isCompact = density === 'compact';

  const hook = useAskUserQuestion({ questions, toolUseId, sessionId });

  const handleDecline = useCallback(() => {
    const sent = sendInteractiveResponse(sessionId, toolUseId, DECLINE_SENTINEL);
    if (!sent) {
      console.error('Decline response not sent: WebSocket disconnected');
      return;
    }
  }, [sendInteractiveResponse, sessionId, toolUseId]);

  // Focused option index for arrow key navigation (flat index across all questions)
  const [focusedOptionIdx, setFocusedOptionIdx] = useState(0);
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);

  // Build flat option list for arrow key navigation
  const flatOptions = questions.flatMap((q, qIdx) => {
    const opts = hook.processedOptionsMap.get(qIdx) ?? processOptions(q.options, q.custom !== false);
    return opts.map((opt) => ({
      questionIdx: qIdx,
      optionKey: getOptionKey(opt),
      isOther: opt.isOther,
    }));
  });

  // Check if any option has markdown
  const hasAnyMarkdown = useMemo(() =>
    questions.some(q => q.options.some(o => o.markdown)),
  [questions]);

  // Active markdown for preview: hover > keyboard focus > selected
  const activeMarkdown = useMemo(() => {
    // Hover takes priority
    if (hoveredLabel) {
      for (const q of questions) {
        const opts = processOptions(q.options, q.custom !== false);
        const hovered = opts.find(o => getOptionKey(o) === hoveredLabel);
        if (hovered?.markdown) return hovered.markdown;
      }
    }
    // Then keyboard-focused option
    const focusedItem = flatOptions[focusedOptionIdx];
    if (focusedItem) {
      for (const q of questions) {
        const opts = processOptions(q.options, q.custom !== false);
        const focused = opts.find(o => getOptionKey(o) === focusedItem.optionKey);
        if (focused?.markdown) return focused.markdown;
      }
    }
    // Then first selected option with markdown
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const state = hook.questionStates.get(qIdx);
      if (!state) continue;
      const opts = hook.processedOptionsMap.get(qIdx)
        ?? processOptions(questions[qIdx].options, questions[qIdx].custom !== false);
      for (const label of state.selectedLabels) {
        const selected = opts.find(o => getOptionKey(o) === label);
        if (selected?.markdown) return selected.markdown;
      }
    }
    return null;
  }, [hoveredLabel, focusedOptionIdx, flatOptions, questions, hook.questionStates, hook.processedOptionsMap]);

  // Auto-focus container on mount — only if this panel is the active panel
  // (prevents stealing focus from another panel where the user is typing)
  useEffect(() => {
    const ps = usePanelStore.getState();
    const tabData = selectActiveTab(ps);
    const activePanelId = tabData?.activePanelId ?? '';
    const panels = tabData?.panels ?? {};
    if (panels[activePanelId]?.sessionId === sessionId) {
      requestAnimationFrame(() => containerRef.current?.focus());
    }
  }, [sessionId]);

  // Global ESC: decline even when container doesn't have focus (활성 패널 한정)
  useEffect(() => {
    const handleGlobalEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      const panelState = usePanelStore.getState();
      const tabData = selectActiveTab(panelState);
      const panelActiveSessionId = tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
      if (sessionId !== panelActiveSessionId) return;

      // "Other" input에서 ESC → 컨테이너로 포커스만 이동 (decline 안 함)
      if (document.activeElement instanceof HTMLInputElement &&
          containerRef.current?.contains(document.activeElement)) {
        return; // container onKeyDown이 처리
      }

      // 컨테이너 자체가 포커스면 container onKeyDown이 처리하므로 스킵
      if (document.activeElement === containerRef.current) return;

      e.preventDefault();
      e.stopPropagation();
      handleDecline();
    };

    window.addEventListener('keydown', handleGlobalEsc);
    return () => window.removeEventListener('keydown', handleGlobalEsc);
  }, [sessionId, handleDecline]);

  // Refocus container (used when escaping from Other input)
  const refocusContainer = useCallback(() => {
    containerRef.current?.focus();
  }, []);

  // ↑/↓로 옮긴 항목이 스크롤 영역 밖이면 따라 스크롤한다.
  // 옵션 버튼은 tabIndex={-1}이라 DOM 포커스가 컨테이너에 머물러 브라우저 기본 스크롤이 안 걸린다.
  // scrollIntoView 대신 scrollTop을 직접 계산하는 이유: 조상(채팅 본문)까지 같이 스크롤되면 안 된다.
  useEffect(() => {
    const area = scrollAreaRef.current;
    const el = optionRefs.current[focusedOptionIdx];
    if (!area || !el) return;

    // 질문의 첫 옵션이면 header/질문 문구까지 보이도록 fieldset 기준으로 맞춘다
    const target = el.hasAttribute('data-first-option') ? (el.closest('fieldset') ?? el) : el;
    const areaBox = area.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const margin = 6;
    // 타겟이 영역보다 크면(옵션 많은 질문) 하단 정렬은 하지 않는다 — 질문 문구가 위로 잘려 나간다
    const overflows = box.height > areaBox.height - margin * 2;

    if (box.top < areaBox.top + margin) {
      area.scrollTop -= areaBox.top + margin - box.top;
    } else if (!overflows && box.bottom > areaBox.bottom - margin) {
      area.scrollTop += box.bottom - (areaBox.bottom - margin);
    }
  }, [focusedOptionIdx, density]);

  // Keyboard: ↑/↓ navigate, Space toggle, Enter select+submit, Esc decline, number keys
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // In "Other" text input: handle Escape, ArrowUp to escape back, Enter to submit
    if (e.target instanceof HTMLInputElement) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setFocusedOptionIdx(prev => Math.max(0, prev - 1));
        refocusContainer();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // First ESC from input → back to container; second ESC from container → decline
        refocusContainer();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (hook.isAllAnswered && hook.submissionState !== 'submitting') {
          hook.submit();
        }
      }
      // All other keys: let the input handle normally
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleDecline();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedOptionIdx(prev => Math.max(0, prev - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedOptionIdx(prev => Math.min(flatOptions.length - 1, prev + 1));
    } else if (e.key === ' ') {
      e.preventDefault();
      const item = flatOptions[focusedOptionIdx];
      if (item) {
        hook.toggleOption(item.questionIdx, item.optionKey);
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (hook.isAllAnswered && hook.submissionState !== 'submitting') {
        hook.submit();
      } else {
        // Not all answered → toggle focused option as convenience
        const item = flatOptions[focusedOptionIdx];
        if (item) {
          hook.toggleOption(item.questionIdx, item.optionKey);
        }
      }
    } else {
      // Number keys 1-9
      const digit = parseInt(e.key, 10);
      if (!isNaN(digit) && digit >= 1 && digit <= flatOptions.length) {
        e.preventDefault();
        const item = flatOptions[digit - 1];
        if (item) {
          hook.toggleOption(item.questionIdx, item.optionKey);
          setFocusedOptionIdx(digit - 1);
        }
      }
    }
  }, [flatOptions, focusedOptionIdx, hook, handleDecline, refocusContainer]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-interactive-prompt
      style={promptDensityVars(density)}
      className="rounded-lg border border-(--accent)/20 bg-(--accent)/5 shadow-lg overflow-hidden max-h-[var(--aqp-max-h)] flex flex-col focus:outline-none"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-[var(--aqp-bar-px)] py-[var(--aqp-bar-py)] border-b border-(--accent)/10 shrink-0">
        <MessageCircleQuestion className="w-3.5 h-3.5 text-(--accent) shrink-0" />
        <ProviderLogoMark
          providerId={providerId}
          className="h-4 w-4 rounded shrink-0"
          iconClassName="h-3 w-3"
        />
        <span
          className="text-[length:var(--aqp-label-font)] font-medium truncate"
          style={{ color: providerBrand.tone.icon }}
        >
          {providerBrand.label}
        </span>
        <span className="text-[10px] text-(--text-muted) ml-auto truncate">
          {t('chat.askUserKeyboardHint')}
        </span>
        {/* Density controls — 패널이 채팅 본문을 가릴 때 사용자가 직접 줄인다 */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('chat.promptDensityDecrease')}
            title={t('chat.promptDensityDecrease')}
            disabled={densityIdx <= 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => stepDensity(-1)}
            className="p-0.5 rounded text-(--text-muted) hover:text-(--text-primary) hover:bg-(--accent)/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <Minus className="w-3 h-3" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('chat.promptDensityIncrease')}
            title={t('chat.promptDensityIncrease')}
            disabled={densityIdx >= PROMPT_DENSITY_ORDER.length - 1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => stepDensity(1)}
            className="p-0.5 rounded text-(--text-muted) hover:text-(--text-primary) hover:bg-(--accent)/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Scrollable questions area */}
      <div
        ref={scrollAreaRef}
        className="overflow-y-auto p-[var(--aqp-body-pad)] space-y-[var(--aqp-block-gap)]"
        style={{ containerType: 'inline-size' }}
      >
        {questions.map((q, qIdx) => {
          const opts = hook.processedOptionsMap.get(qIdx) ?? processOptions(q.options, q.custom !== false);
          const state = hook.questionStates.get(qIdx);
          // Calculate global start index for this question's options
          let globalStart = 0;
          for (let i = 0; i < qIdx; i++) {
            const prevOpts = hook.processedOptionsMap.get(i)
              ?? processOptions(questions[i].options, questions[i].custom !== false);
            globalStart += prevOpts.length;
          }

          return (
            <fieldset
              key={qIdx}
              className={cn(
                'rounded-lg border p-[var(--aqp-block-pad)]',
                hook.unansweredIndices.includes(qIdx) && hook.submissionState === 'error'
                  ? 'border-(--error)/50'
                  : 'border-(--divider)',
              )}
            >
              <legend className="px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider bg-(--accent)/15 text-(--accent) rounded">
                {q.header}
              </legend>
              <p className="text-[length:var(--aqp-question-font)] leading-snug text-(--text-primary) mb-[var(--aqp-opt-gap)] mt-0.5">
                {q.question}
              </p>
              {/* Options + Markdown Preview layout */}
              <div className={cn('flex gap-2', hasAnyMarkdown ? 'flex-row' : 'flex-col')}>
                {/* Option list */}
                <div
                  className={cn('space-y-[var(--aqp-opt-space)]', hasAnyMarkdown ? 'flex-1 min-w-0' : '')}
                  role={q.multiSelect ? 'group' : 'radiogroup'}
                  aria-label={q.header}
                >
                  {opts.map((opt, optIdx) => {
                    const optKey = getOptionKey(opt);
                    const isSelected = opt.isOther
                      ? (state?.otherSelected ?? false)
                      : (state?.selectedLabels.has(optKey) ?? false);
                    const globalIdx = globalStart + optIdx;
                    const isFocused = globalIdx === focusedOptionIdx;

                    return (
                      <div
                        key={optKey}
                        ref={(el) => {
                          optionRefs.current[globalIdx] = el;
                        }}
                        data-first-option={optIdx === 0 ? '' : undefined}
                      >
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          tabIndex={-1}
                          onClick={() => {
                            hook.toggleOption(qIdx, optKey);
                            setFocusedOptionIdx(globalIdx);
                          }}
                          onMouseEnter={() => setHoveredLabel(optKey)}
                          onMouseLeave={() => setHoveredLabel(null)}
                          className={cn(
                            'w-full flex items-center gap-[var(--aqp-opt-gap)] px-[var(--aqp-opt-px)] py-[var(--aqp-opt-py)] rounded-md text-left transition-colors duration-150',
                            // border width 고정 (1px) — focus는 ring으로 표시해서 레이아웃 시프트 방지
                            'border',
                            !isSelected && !isFocused && 'bg-(--sidebar-hover) border-(--divider) hover:border-(--accent)/30 hover:bg-(--accent)/8',
                            !isSelected && isFocused && 'bg-(--sidebar-hover) border-(--accent)/50 ring-1 ring-(--accent)/50',
                            isSelected && !isFocused && 'bg-(--accent)/15 border-(--accent)',
                            isSelected && isFocused && 'bg-(--accent)/15 border-(--accent) ring-1 ring-(--accent)',
                          )}
                        >
                          {/* Selection indicator — 미선택이면 번호 배지를 겸한다 */}
                          <span
                            className={cn(
                              'shrink-0 flex items-center justify-center border font-mono text-[9px] leading-none transition-colors duration-150',
                              q.multiSelect ? 'rounded' : 'rounded-full',
                              isSelected
                                ? 'bg-(--accent) border-(--accent) text-white'
                                : 'border-(--text-muted)/40 text-(--text-muted)',
                            )}
                            style={{ width: 'var(--aqp-ctrl)', height: 'var(--aqp-ctrl)' }}
                          >
                            {isSelected ? '✓' : globalIdx + 1}
                          </span>
                          {/* Text */}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-[length:var(--aqp-label-font)] leading-snug text-(--text-primary)">
                              {opt.label}
                            </div>
                            {opt.description && (
                              <div
                                className={cn(
                                  'text-[length:var(--aqp-desc-font)] leading-snug text-(--text-secondary)',
                                  // compact에서는 설명을 2줄로 자르고, 보고 있는 항목만 펼친다
                                  isCompact && !isFocused && !isSelected && 'line-clamp-2',
                                )}
                              >
                                {opt.description}
                              </div>
                            )}
                          </div>
                          {/* Markdown indicator */}
                          {opt.markdown && <FileCode2 className="w-3 h-3 text-(--text-muted) shrink-0" />}
                          {/* Focus indicator */}
                          {isFocused && (
                            <span className="text-[9px] text-(--accent) font-mono shrink-0">◀</span>
                          )}
                        </button>
                        {opt.isOther && isSelected && (
                          <input
                            type={q.isSecret ? 'password' : 'text'}
                            value={state?.otherText ?? ''}
                            onChange={(e) => hook.setOtherText(qIdx, e.target.value)}
                            placeholder={t('chat.otherInputPlaceholderWithHint')}
                            autoComplete={q.isSecret ? 'off' : undefined}
                            autoFocus
                            className="mt-1 w-full px-[var(--aqp-opt-px)] py-[var(--aqp-opt-py)] text-[length:var(--aqp-label-font)] bg-(--input-bg) border border-(--input-border) rounded-md text-(--text-primary) placeholder:text-(--input-placeholder) focus:outline-none focus:ring-1 focus:ring-(--accent)"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Markdown preview panel */}
                {hasAnyMarkdown && activeMarkdown && (
                  <div
                    className="flex-1 max-h-[var(--aqp-preview-max-h)] overflow-y-auto rounded-lg border border-(--divider) bg-(--sidebar-hover) p-[var(--aqp-block-pad)] text-[length:var(--aqp-desc-font)] text-(--text-secondary) transition-opacity duration-200"
                    data-testid="markdown-preview"
                  >
                    <PreviewMarkdown content={activeMarkdown} />
                  </div>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>

      {/* Submit bar */}
      <div className="px-[var(--aqp-bar-px)] py-[var(--aqp-bar-py)] border-t border-(--accent)/10 flex items-center justify-between gap-3 shrink-0">
        <div className="text-[11px] text-(--text-muted)">
          {hook.submissionState === 'error' && (
            <span className="text-(--error)">{t('chat.submissionFailed')}</span>
          )}
          {hook.submissionState !== 'error' && !hook.isAllAnswered && (
            <span>{t('chat.unansweredQuestions', { count: hook.unansweredIndices.length })}</span>
          )}
        </div>
        {hook.submissionState === 'error' ? (
          <button
            onClick={hook.retrySubmit}
            tabIndex={-1}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[length:var(--aqp-label-font)] rounded-md bg-(--accent) text-white hover:bg-(--accent-hover) transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            {t('chat.retrySubmit')}
          </button>
        ) : (
          <button
            onClick={hook.submit}
            disabled={!hook.isAllAnswered || hook.submissionState === 'submitting'}
            tabIndex={-1}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 text-[length:var(--aqp-label-font)] rounded-md transition-colors',
              hook.isAllAnswered && hook.submissionState !== 'submitting'
                ? 'bg-(--accent) text-white hover:bg-(--accent-hover)'
                : 'bg-(--sidebar-hover) text-(--text-muted) cursor-not-allowed',
            )}
          >
            {hook.submissionState === 'submitting' ? (
              <><Loader2 className="w-3 h-3 animate-spin" /> {t('chat.submitting')}</>
            ) : (
              <><Send className="w-3 h-3" /> {t('chat.submitHint')} <kbd className="ml-1 text-[10px] opacity-70 font-mono">↵</kbd></>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
