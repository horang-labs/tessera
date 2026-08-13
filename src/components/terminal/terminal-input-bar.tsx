'use client';

import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Loader2, SendHorizontal } from 'lucide-react';
import {
  TERMINAL_INPUT_BAR_KEYS,
  terminalInputBarKeySequence,
  terminalInputBarTextPayload,
} from '@/lib/terminal/terminal-input-bar-input';
import type { TerminalNamedKey } from '@/lib/terminal/session-control-input';
import { TERMINAL_IMAGE_FILE_ACCEPT } from '@/lib/terminal/terminal-clipboard-paste';
import { cn } from '@/lib/utils';
import { PHONE_TOUCH_TARGET, PHONE_TOUCH_TARGET_HEIGHT } from '@/lib/ui/touch-target';

interface TerminalInputBarProps {
  onSend: (data: string) => boolean;
  onAttachImage: (file: File) => Promise<boolean>;
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
 * The bar sits below the terminal and owns keyboard input at a Phone viewport. Its panel
 * binds it to the exact surface it belongs to, so that surface retains a preview only after
 * bytes were delivered. The terminal surface keeps pointer and touch ownership.
 *
 * It is **buffered**: what is typed goes out on submit, not per keystroke. That is also
 * what makes Hangul and every other composed script work without help — a composition
 * has finished by the time the user taps send, so the browser's own
 * composition handling is all that is needed.
 */
export function TerminalInputBar({
  onSend,
  onAttachImage,
  isTabActive = true,
}: TerminalInputBarProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<'send' | 'image' | null>(null);
  const [isAttachingImage, setIsAttachingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageAttachmentInFlightRef = useRef(false);

  const send = useCallback((data: string) => {
    const delivered = onSend(data);
    setFailure(delivered ? null : 'send');
    return delivered;
  }, [onSend]);

  const handleSubmit = useCallback(() => {
    const payload = terminalInputBarTextPayload(text);
    if (payload === null) return;
    // The text is cleared only once it is on the wire. A send that found no live
    // terminal must not also lose what the user typed — retyping it on a phone is the
    // expensive part.
    if (send(payload)) setText('');
  }, [send, text]);

  const handleKey = useCallback((key: TerminalNamedKey) => {
    send(terminalInputBarKeySequence(key));
  }, [send]);

  const handleImageSelect = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || imageAttachmentInFlightRef.current) return;

    imageAttachmentInFlightRef.current = true;
    setIsAttachingImage(true);
    setFailure(null);
    try {
      const delivered = await onAttachImage(file);
      setFailure(delivered ? null : 'image');
    } catch {
      setFailure('image');
    } finally {
      imageAttachmentInFlightRef.current = false;
      setIsAttachingImage(false);
    }
  }, [onAttachImage]);

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
          answers. 44px targets remain large enough to use without crowding the row.

          The size comes from PHONE_TOUCH_TARGET rather than `h-11 min-w-11`, which this
          bar shipped with. `rem` resolves against a root font the user scales, so those
          classes were 44px at the default scale and 35.75px at the smallest — which is
          the scale QA measured at, and why these keys came out 47x36 against a 44px
          budget. Restating 44 by hand here would be a third place for the same
          arithmetic to go wrong (#259). */}
      {/* 4-column grid wraps the row into two lines once the set grows past 5
          keys — a straight flex row with `min-w-11` overflowed 360px viewports
          the moment left/right/backspace joined the original five. Grid also
          gives every cell the same width regardless of icon label. */}
      <div className="grid grid-cols-4 gap-1">
        {TERMINAL_INPUT_BAR_KEYS.map((key) => (
          <button
            key={key.namedKey}
            type="button"
            onClick={() => handleKey(key.namedKey)}
            aria-label={t(key.labelKey)}
            title={t(key.labelKey)}
            data-testid={`terminal-input-bar-key-${key.namedKey}`}
            className={cn(
              'rounded border border-(--divider) bg-(--chat-header-bg) text-xs font-medium text-(--text-primary) active:bg-black/10 dark:active:bg-white/15',
              PHONE_TOUCH_TARGET,
            )}
          >
            {key.label}
          </button>
        ))}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={TERMINAL_IMAGE_FILE_ACCEPT}
        className="hidden"
        onChange={handleImageSelect}
        disabled={isAttachingImage}
        tabIndex={-1}
        data-testid="terminal-input-bar-image-input"
      />
      <div className="mt-2 flex items-end gap-1">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isAttachingImage}
          aria-label={t(
            isAttachingImage
              ? 'chat.terminalInputBar.attachingImage'
              : 'chat.terminalInputBar.attachImage',
          )}
          title={t(
            isAttachingImage
              ? 'chat.terminalInputBar.attachingImage'
              : 'chat.terminalInputBar.attachImage',
          )}
          aria-busy={isAttachingImage}
          data-testid="terminal-input-bar-attach-image"
          className={cn(
            'flex shrink-0 items-center justify-center rounded border border-(--divider) bg-(--chat-header-bg) text-(--text-primary) disabled:opacity-40 active:bg-black/10 dark:active:bg-white/15',
            PHONE_TOUCH_TARGET,
          )}
        >
          {isAttachingImage
            ? <span className="animate-spin"><Loader2 className="h-4 w-4" /></span>
            : <ImagePlus className="h-4 w-4" />}
        </button>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={1}
          placeholder={t('chat.terminalInputBar.placeholder')}
          aria-label={t('chat.terminalInputBar.placeholder')}
          data-testid="terminal-input-bar-textarea"
          data-terminal-input-owner="input-bar"
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
      {failure && (
        <p
          role="status"
          data-testid="terminal-input-bar-error"
          className="mt-1 text-xs text-(--text-secondary)"
        >
          {t(
            failure === 'image'
              ? 'chat.terminalInputBar.imageAttachFailed'
              : 'chat.terminalSendFailed',
          )}
        </p>
      )}
    </div>
  );
}
