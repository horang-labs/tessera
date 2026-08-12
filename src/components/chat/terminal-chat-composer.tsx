'use client';

import { memo, useCallback, useRef, useState } from 'react';
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
import {
  failPendingTerminalChatMessage,
  registerPendingTerminalChatMessage,
} from '@/lib/chat/terminal-chat-live-refresh';
import {
  resolveComposerArrowScroll,
  scrollSessionMessages,
} from '@/lib/chat/composer-arrow-scroll';
import { MessageRowShell } from './message-row-shell';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';

export const TerminalChatCancelButton = memo(function TerminalChatCancelButton({
  onCancel,
}: {
  onCancel: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onCancel}
      title={t('chat.cancelButton')}
      aria-label={t('chat.cancelButton')}
      className={cn(
        'flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-(--error) px-2 py-1',
        'text-white transition-colors hover:bg-(--destructive-hover)',
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
 * Text goes to the terminal as a paste followed by Enter (terminal-chat-send.ts),
 * so this stays deliberately plain: no attachments, no slash-command handling,
 * no skill picker. Those need the TUI's own input affordances, and the input's
 * accessible name says so rather than letting the surface look more capable
 * than it is.
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 권한/질문 프롬프트가 떠 있는 동안은 TUI 입력 칸이 그 프롬프트 것이다. 여기서
  // 보낸 텍스트는 프롬프트 응답으로 먹혀 엉뚱하게 동작하므로 막는다.
  const isBlocked = isAwaitingInput;

  const submit = useCallback(() => {
    const text = value;
    if (!text.trim() || isBlocked) return;

    const handle = sendTerminalChatMessage(sessionId, text);
    if (!handle) {
      toast.error(t('chat.terminalSendFailed'));
      return;
    }

    // 낙관적 표시. 에이전트는 턴이 끝나야 transcript를 flush하므로(codex 실측 ~35초)
    // 그 전에 도는 갱신이 서버의 옛 목록으로 화면을 덮어쓴다. 등록해 두면 갱신 때마다
    // 다시 붙었다가, 실제 기록에 나타나는 순간 빠진다.
    const pendingMessageId = registerPendingTerminalChatMessage(sessionId, text);
    void handle.submitted.then((submitted) => {
      if (submitted) return;
      failPendingTerminalChatMessage(sessionId, pendingMessageId);
      toast.error(t('chat.terminalSendFailed'));
    });

    setValue('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [isBlocked, sessionId, t, value]);

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

  const canSubmit = !!value.trim() && !isBlocked;

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
            className={cn(
              'relative rounded-lg border transition-colors',
              'bg-(--input-bg) border-(--input-border)',
              !isBlocked && 'focus-within:border-(--accent)/50',
              isBlocked && 'opacity-60',
            )}
          >
            <div className="flex items-end gap-2 px-3 py-2">
              <textarea
                ref={textareaRef}
                // MessageList가 빈 영역 클릭 시 이 selector로 입력창을 찾아 포커스한다.
                // 터미널 세션에서는 MessageInput이 렌더되지 않으므로 중복되지 않는다.
                data-session-input={sessionId}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isBlocked}
                rows={1}
                // The visible hint has to fit the one line this box is tall: at
                // 360px it is 204px wide, and the sentence that named the
                // attachment limit wrapped onto a second line the user cannot
                // scroll to, so it read as ending on "no" (#271). The whole
                // sentence stays as the accessible name and as the pointer
                // tooltip, both of which have no such line — and it follows the
                // state, or a blocked box would announce that it takes text.
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
                <ArrowUp className="h-3.5 w-3.5" />
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
