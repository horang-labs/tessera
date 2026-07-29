'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { ArrowUp, Loader2, Lock, SquareTerminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/stores/notification-store';
import { useChatStore } from '@/stores/chat-store';
import {
  selectIsTerminalAwaitingInput,
  selectIsTerminalTurnProcessing,
  useTerminalSessionStore,
} from '@/stores/terminal-session-store';
import { useTerminalViewModeStore } from '@/stores/terminal-view-mode-store';
import { sendTerminalChatMessage } from '@/lib/terminal/terminal-chat-send';
import { MessageRowShell } from './message-row-shell';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';

/**
 * Composer for the chat overlay of a PTY session.
 *
 * Text goes to the terminal as a paste followed by Enter (terminal-chat-send.ts),
 * so this stays deliberately plain: no attachments, no slash-command handling,
 * no skill picker. Those need the TUI's own input affordances, and the
 * placeholder says so rather than letting the surface look more capable than it
 * is.
 *
 * It also carries the PTY's lifecycle state, because the overlay has no other
 * live signal — without it a quiet session is indistinguishable from a broken one.
 */
export const TerminalChatComposer = memo(function TerminalChatComposer({
  sessionId,
  isSinglePanel = false,
}: {
  sessionId: string;
  isSinglePanel?: boolean;
}) {
  const { t } = useI18n();
  const isProcessing = useTerminalSessionStore(selectIsTerminalTurnProcessing(sessionId));
  const isAwaitingInput = useTerminalSessionStore(selectIsTerminalAwaitingInput(sessionId));
  const setMode = useTerminalViewModeStore((state) => state.setMode);
  const addMessage = useChatStore((state) => state.addMessage);

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

    // 낙관적 표시: transcript에 기록되고 훅이 돌아오기까지 몇 초 걸린다. 그동안
    // 화면이 그대로면 전송 여부를 알 수 없다. 다음 갱신에서 loadHistory가 목록을
    // 통째로 교체하므로 진짜 기록으로 자연히 대체된다(중복 없음).
    addMessage(sessionId, {
      id: `terminal-chat-pending-${Date.now()}`,
      type: 'text',
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    });

    setValue('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [addMessage, isBlocked, sessionId, t, value]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      // 한글 등 IME 조합 중의 Enter는 확정이지 전송이 아니다.
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [submit],
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
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isBlocked}
                rows={1}
                placeholder={
                  isBlocked
                    ? t('chat.terminalComposerBlocked')
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
              <button
                type="button"
                onClick={() => setMode(sessionId, 'terminal')}
                title={t('chat.viewAsTerminal')}
                className="ml-auto flex items-center gap-1.5 text-(--text-muted) transition-colors hover:text-(--accent)"
                data-testid="terminal-chat-back-to-terminal"
              >
                <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">{t('chat.terminalComposerHint')}</span>
              </button>
            </div>
          </div>
        </MessageRowShell>
      </div>
    </div>
  );
});
