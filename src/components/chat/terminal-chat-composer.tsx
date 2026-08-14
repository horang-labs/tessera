'use client';

import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowUp, Loader2, Lock, Square, SquareTerminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET } from '@/lib/ui/touch-target';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/notification-store';
import {
  selectCanEscapeInterruptTerminal,
  selectIsTerminalAwaitingInput,
  selectIsTerminalTurnProcessing,
  useTerminalSessionStore,
} from '@/stores/terminal-session-store';
import { useTerminalViewModeStore } from '@/stores/terminal-view-mode-store';
import { sendTerminalChatMessage } from '@/lib/terminal/terminal-chat-send';
import { registerPendingTerminalChatMessage } from '@/lib/chat/terminal-chat-live-refresh';
import {
  getWorkspaceFileDragAbsolutePath,
  hasWorkspaceFileDragData,
} from '@/lib/dnd/panel-session-drag';
import {
  getNativeFileDropAbsolutePaths,
  isNativeFileDrag,
} from '@/lib/dnd/native-file-drop';
import { uploadTerminalClipboardFile } from '@/lib/terminal/terminal-clipboard-paste';
import { insertTerminalChatPathsAtCursor } from '@/lib/terminal/terminal-chat-composer-input';
import {
  resolveComposerArrowScroll,
  scrollSessionMessages,
} from '@/lib/chat/composer-arrow-scroll';
import { MessageRowShell } from './message-row-shell';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import { telemetryClickAttributes } from '@/lib/telemetry/ui-click';

export const TerminalChatCancelButton = memo(function TerminalChatCancelButton({
  onCancel,
}: {
  onCancel: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      {...telemetryClickAttributes('terminal.chat.cancel', 'terminal')}
      type="button"
      onClick={onCancel}
      title={t('chat.cancelButton')}
      aria-label={t('chat.cancelButton')}
      className={cn(
        'flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-(--status-error-border) px-2 py-1',
        'bg-(--status-error-bg) text-(--status-error-text) transition-colors',
        'hover:bg-[color-mix(in_srgb,var(--status-error-bg)_78%,var(--status-error-text))]',
        PHONE_TOUCH_TARGET,
      )}
      data-testid="terminal-chat-cancel"
    >
      <Square className="h-3 w-3 fill-current" />
      <span className="sm:hidden">ESC</span>
      <span className="hidden sm:inline">{t('chat.cancelButton')}</span>
    </button>
  );
});

/**
 * Composer for the chat overlay of a PTY session.
 *
 * Text and agent-visible paths go to the terminal as a paste followed by Enter
 * (terminal-chat-send.ts). Clipboard images are uploaded first; their returned
 * paths and all dropped paths stay ordinary editable draft text.
 *
 * It also carries the PTY's lifecycle state, because the overlay has no other
 * live signal — without it a quiet session is indistinguishable from a broken one.
 */
export const TerminalChatComposer = memo(function TerminalChatComposer({
  sessionId,
  isSinglePanel = false,
  onInterrupt,
}: {
  sessionId: string;
  isSinglePanel?: boolean;
  onInterrupt: () => void;
}) {
  const { t } = useI18n();
  const isProcessing = useTerminalSessionStore(selectIsTerminalTurnProcessing(sessionId));
  const isAwaitingInput = useTerminalSessionStore(selectIsTerminalAwaitingInput(sessionId));
  const canEscapeInterrupt = useTerminalSessionStore(selectCanEscapeInterruptTerminal(sessionId));
  const setMode = useTerminalViewModeStore((state) => state.setMode);

  const [value, setValue] = useState('');
  const [dragDepth, setDragDepth] = useState(0);
  const [pendingImageUploads, setPendingImageUploads] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const retrySubmissionRef = useRef<{ text: string; id: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDragOver = dragDepth > 0;
  const isUploadingImage = pendingImageUploads > 0;

  useEffect(() => {
    const resizeTextarea = () => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.style.height = 'auto';
      const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    };

    resizeTextarea();
    const frame = requestAnimationFrame(resizeTextarea);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  // 권한/질문 프롬프트가 떠 있는 동안은 TUI 입력 칸이 그 프롬프트 것이다. 여기서
  // 보낸 텍스트는 프롬프트 응답으로 먹혀 엉뚱하게 동작하므로 막는다.
  const isBlocked = isAwaitingInput;

  const insertPaths = useCallback((paths: string[]) => {
    const textarea = textareaRef.current;
    const currentValue = textarea?.value ?? '';
    const cursorPos = textarea?.selectionStart ?? currentValue.length;
    const edit = insertTerminalChatPathsAtCursor(currentValue, cursorPos, paths);
    setValue(edit.nextValue);
    requestAnimationFrame(() => {
      const input = textareaRef.current;
      input?.setSelectionRange(edit.nextCursorPos, edit.nextCursorPos);
      input?.focus();
    });
  }, []);

  const acceptsPathDrop = useCallback((dataTransfer: DataTransfer) => (
    isNativeFileDrag(dataTransfer) || hasWorkspaceFileDragData(dataTransfer)
  ), []);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (isBlocked || isSubmitting || !acceptsPathDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragDepth((depth) => depth + 1);
  }, [acceptsPathDrop, isBlocked, isSubmitting]);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (isBlocked || isSubmitting || !acceptsPathDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = isNativeFileDrag(event.dataTransfer) ? 'copy' : 'move';
  }, [acceptsPathDrop, isBlocked, isSubmitting]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!acceptsPathDrop(event.dataTransfer)) return;
    event.stopPropagation();
    setDragDepth((depth) => Math.max(0, depth - 1));
  }, [acceptsPathDrop]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!acceptsPathDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragDepth(0);
    if (isBlocked || isSubmitting) return;

    const paths = isNativeFileDrag(event.dataTransfer)
      ? getNativeFileDropAbsolutePaths(event.dataTransfer)
      : [getWorkspaceFileDragAbsolutePath(event.dataTransfer)].filter(
          (path): path is string => Boolean(path),
        );
    insertPaths(paths);
  }, [acceptsPathDrop, insertPaths, isBlocked, isSubmitting]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Match the desktop PTY clipboard policy: when a clipboard exposes both,
    // ordinary text wins and the textarea's native paste remains untouched.
    if (event.clipboardData.getData('text/plain')) return;
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;

    event.preventDefault();
    setPendingImageUploads((count) => count + imageFiles.length);
    void Promise.all(imageFiles.map(uploadTerminalClipboardFile))
      .then(insertPaths)
      .catch(() => toast.error(t('chat.terminalInputBar.imageAttachFailed')))
      .finally(() => {
        setPendingImageUploads((count) => Math.max(0, count - imageFiles.length));
        requestAnimationFrame(() => textareaRef.current?.focus());
      });
  }, [insertPaths, t]);

  const submit = useCallback(async () => {
    const text = value;
    if (!text.trim() || isBlocked || isUploadingImage || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const submission = retrySubmissionRef.current?.text === text
        ? retrySubmissionRef.current
        : { text, id: crypto.randomUUID() };
      retrySubmissionRef.current = submission;
      const result = await sendTerminalChatMessage(sessionId, text, submission.id);
      if (!result.accepted) {
        if (result.reason === 'server') retrySubmissionRef.current = null;
        toast.error(result.message ?? t('chat.terminalSendFailed'));
        return;
      }
      retrySubmissionRef.current = null;

      // 서버가 같은 PTY runtime에 본문과 Enter를 모두 쓴 뒤에만 표시한다.
      // 에이전트는 턴이 끝나야 transcript를 flush하므로(codex 실측 ~35초),
      // 실제 기록에 나타날 때까지 pending 목록이 새로고침 사이에서도 유지한다.
      registerPendingTerminalChatMessage(sessionId, text);

      setValue((current) => current === text ? '' : current);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isBlocked, isUploadingImage, sessionId, t, value]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // GUI 컴포저와 같은 규칙: 캐럿이 첫/마지막 줄이면 위/아래 키를 메시지 목록 스크롤에 넘긴다.
      const arrowScroll = resolveComposerArrowScroll(event, value, event.currentTarget.selectionStart);
      if (arrowScroll !== 'ignore') {
        if (scrollSessionMessages(sessionId, arrowScroll)) {
          event.preventDefault();
        }
        return;
      }

      if (event.key !== 'Enter' || event.shiftKey) return;
      // 한글 등 IME 조합 중의 Enter는 확정이지 전송이 아니다.
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [sessionId, submit, value],
  );

  const status = isProcessing
    ? {
        icon: <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />,
        label: t('chat.terminalWorkingNotice'),
        tone: 'text-(--text-muted)',
      }
    : isAwaitingInput
      ? {
          icon: (
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-(--warning)" aria-hidden />
          ),
          label: t('chat.terminalWaitingNotice'),
          tone: 'text-(--warning)',
        }
      : {
          icon: <Lock className="h-3.5 w-3.5 shrink-0" />,
          label: t('chat.terminalReadOnlyNotice'),
          tone: 'text-(--text-muted)',
        };

  const canSubmit = !!value.trim() && !isBlocked && !isSubmitting && !isUploadingImage;

  // What the shortened placeholders were shortened from. The placeholder is the
  // accessible name when nothing else names the input, so this has to say the
  // same thing the visible hint does, only in full.
  const accessibleName = isBlocked
    ? t('chat.terminalComposerBlockedLabel')
    : t('chat.terminalComposerLabel');

  return (
    <div className="shrink-0 pb-2 pt-0">
      <div className={cn('w-full', isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-4')}>
        {/* 컴포저와 같은 shell — 메시지 열에 정렬된다. */}
        <MessageRowShell>
          <div
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              'relative rounded-lg border transition-colors',
              'bg-(--input-bg) border-(--input-border)',
              !isBlocked && 'focus-within:border-(--accent)/50',
              isBlocked && 'opacity-60',
              isDragOver && 'border-(--accent) ring-2 ring-(--accent)/30 ring-inset',
            )}
          >
            <div className="flex items-end gap-2 px-3 py-2">
              <textarea
                {...telemetryClickAttributes('terminal.chat.input', 'terminal')}
                ref={textareaRef}
                // MessageList가 빈 영역 클릭 시 이 selector로 입력창을 찾아 포커스한다.
                // 터미널 세션에서는 MessageInput이 렌더되지 않으므로 중복되지 않는다.
                data-session-input={sessionId}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                disabled={isBlocked || isSubmitting}
                aria-busy={isUploadingImage}
                rows={1}
                // Keep the visible hint short enough for the one-line phone box.
                // The full capability description stays in the accessible name
                // and pointer tooltip, which do not clip like a placeholder (#271).
                aria-label={accessibleName}
                title={accessibleName}
                placeholder={
                  isBlocked
                    ? t('chat.terminalComposerBlocked')
                    : isProcessing && canEscapeInterrupt
                      ? t('chat.cancelHint')
                      : t('chat.terminalComposerPlaceholder')
                }
                className={cn(
                  'max-h-40 min-h-[1.75rem] flex-1 resize-none overflow-y-auto bg-transparent',
                  'py-1 text-sm text-(--input-text) placeholder:text-(--text-muted)',
                  'focus:outline-none disabled:cursor-not-allowed',
                )}
                data-testid="terminal-chat-composer-input"
              />
              <button
                {...telemetryClickAttributes('terminal.chat.send', 'terminal')}
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                title={t('chat.send')}
                aria-label={t('chat.send')}
                className={cn(
                  'mb-0.5 shrink-0 rounded-md p-1.5 transition-colors',
                  PHONE_TOUCH_TARGET,
                  canSubmit
                    ? 'bg-(--accent) text-white hover:opacity-90'
                    : 'text-(--text-muted) opacity-40',
                )}
                data-testid="terminal-chat-composer-send"
              >
                {isUploadingImage
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <ArrowUp className="h-3.5 w-3.5" />}
              </button>
            </div>

            <div className="flex items-center gap-2 border-t border-(--divider) px-3 py-1.5 text-[11px]">
              <span
                className={cn('flex items-center gap-1.5', status.tone)}
                role="status"
                aria-live="polite"
              >
                {status.icon}
                <span>{status.label}</span>
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {isProcessing && canEscapeInterrupt
                  ? <TerminalChatCancelButton onCancel={onInterrupt} />
                  : null}
                <button
                  {...telemetryClickAttributes('terminal.chat.open_terminal', 'terminal')}
                  type="button"
                  onClick={() => setMode(sessionId, 'terminal')}
                  title={t('chat.viewAsTerminal')}
                  className={cn(
                    'flex items-center gap-1.5 text-(--text-muted) transition-colors hover:text-(--accent)',
                    // The label is hidden below `sm`, which left a bare 14px
                    // glyph as the only way back to the terminal (#259).
                    PHONE_TOUCH_TARGET,
                  )}
                  data-testid="terminal-chat-back-to-terminal"
                >
                  <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">{t('chat.terminalComposerHint')}</span>
                </button>
              </div>
            </div>
          </div>
        </MessageRowShell>
      </div>
    </div>
  );
});
