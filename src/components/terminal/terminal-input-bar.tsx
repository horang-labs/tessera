'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SendHorizontal } from 'lucide-react';
import {
  TERMINAL_INPUT_BAR_KEYS,
  terminalInputBarKeySequence,
  terminalInputBarTextPayload,
} from '@/lib/terminal/terminal-input-bar-input';
import { sendInputToTerminal } from '@/lib/terminal/terminal-surface-registry';
import type { TerminalNamedKey } from '@/lib/terminal/session-control-input';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET, PHONE_TOUCH_TARGET_HEIGHT } from '@/lib/ui/touch-target';

interface TerminalInputBarProps {
  terminalId: string;
  /**
   * Whether this bar's tab is the one on screen.
   *
   * An inactive tab's slot keeps `visibility: hidden` and `aria-hidden` — which is
   * right, and untouched — but it is still laid out, so a second bar sat at the active
   * one's exact coordinates (#262). Laying out a hidden session's bar is wasted work,
   * and two bars stacked on one point is what a focus or shortcut change would trip
   * over later. An inactive bar therefore drops out of layout rather than unmounting:
   * a draft typed before a tab switch is still there on the way back.
   */
  isTabActive?: boolean;
}

/**
 * The Terminal input bar: how a phone types into a PTY session.
 *
 * It exists because the terminal surface carries no input element a phone can focus.
 * xterm's own `.xterm-helper-textarea` is parked off-screen at zero size with zero
 * opacity, so there is nothing to tap, and Android Chrome will not raise the soft
 * keyboard for a programmatic `focus()` on it. A real, visible field is the whole point:
 * the browser raises the keyboard for a tap on a real textarea and for nothing else.
 *
 * The bar sits below the terminal and the terminal knows nothing about it. It writes to
 * the PTY through the same registry send path the chat overlay and the file-path insert
 * already use, and it touches no xterm option.
 *
 * It is **buffered**: what is typed goes out on submit, not per keystroke. That is also
 * what makes Hangul and every other composed script work without help — a composition
 * has finished by the time the user taps send, so the browser's own
 * composition handling is all that is needed.
 */
export function TerminalInputBar({ terminalId, isTabActive = true }: TerminalInputBarProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [didFail, setDidFail] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = useCallback((data: string) => {
    const delivered = sendInputToTerminal(terminalId, data);
    setDidFail(!delivered);
    return delivered;
  }, [terminalId]);

  const handleSubmit = useCallback(() => {
    const payload = terminalInputBarTextPayload(text);
    if (payload === null) return;
    // The text is cleared only once it is on the wire. A send that found no live
    // terminal must not also lose what the user typed — retyping it on a phone is the
    // expensive part.
    if (send(payload)) setText('');
    textareaRef.current?.focus();
  }, [send, text]);

  const handleKey = useCallback((key: TerminalNamedKey) => {
    // Ctrl+C included, deliberately without a confirmation step: its purpose is stopping
    // something already going wrong, and a dialog in front of it defeats that. A misfire
    // costs one interrupted turn; an unreachable Ctrl+C costs the session.
    send(terminalInputBarKeySequence(key));
  }, [send]);

  return (
    <div
      className={cn(
        'shrink-0 border-t border-black/10 bg-(--chat-bg) p-2 dark:border-white/10',
        !isTabActive && 'hidden',
      )}
      data-testid="terminal-input-bar"
      role="group"
      aria-label={t('chat.terminalInputBar.label')}
    >
      {/* The keys sit against the terminal, so pressing one lands next to the prompt it
          answers. 44px targets with 4px gaps take 284px of the 344px a 360px screen
          leaves inside this padding.

          The size comes from PHONE_TOUCH_TARGET rather than `h-11 min-w-11`, which this
          bar shipped with. `rem` resolves against a root font the user scales, so those
          classes were 44px at the default scale and 35.75px at the smallest — which is
          the scale QA measured at, and why these keys came out 47x36 against a 44px
          budget. Restating 44 by hand here would be a third place for the same
          arithmetic to go wrong (#259). */}
      <div className="flex gap-1">
        {TERMINAL_INPUT_BAR_KEYS.map((key) => (
          <button
            key={key.namedKey}
            type="button"
            onClick={() => handleKey(key.namedKey)}
            aria-label={t(key.labelKey)}
            title={t(key.labelKey)}
            data-testid={`terminal-input-bar-key-${key.namedKey}`}
            className={cn(
              'flex-1 rounded border border-(--divider) bg-(--chat-header-bg) text-xs font-medium text-(--text-primary) active:bg-black/10 dark:active:bg-white/15',
              PHONE_TOUCH_TARGET,
            )}
          >
            {key.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-end gap-1">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={1}
          placeholder={t('chat.terminalInputBar.placeholder')}
          aria-label={t('chat.terminalInputBar.placeholder')}
          data-testid="terminal-input-bar-textarea"
          // min-w-0 so the textarea yields instead of pushing send off the screen
          // (#251) — so this takes the height floor only, never a width one.
          className={cn(
            'min-w-0 flex-1 resize-none rounded border border-(--divider) bg-(--chat-bg) px-2 py-2.5 text-sm text-(--text-primary) outline-none focus:border-(--accent)',
            PHONE_TOUCH_TARGET_HEIGHT,
          )}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={terminalInputBarTextPayload(text) === null}
          aria-label={t('chat.terminalInputBar.send')}
          title={t('chat.terminalInputBar.send')}
          data-testid="terminal-input-bar-send"
          // The worst of the bar, and unmeasured until now: `h-11 w-11` made this
          // 35.75x35.75 at the smallest font scale, square rather than merely short.
          className={cn(
            'flex shrink-0 items-center justify-center rounded border border-(--divider) bg-(--chat-header-bg) text-(--text-primary) disabled:opacity-40 active:bg-black/10 dark:active:bg-white/15',
            PHONE_TOUCH_TARGET,
          )}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
      {didFail && (
        <p
          role="status"
          data-testid="terminal-input-bar-error"
          className="mt-1 text-xs text-(--text-secondary)"
        >
          {t('chat.terminalSendFailed')}
        </p>
      )}
    </div>
  );
}
