/**
 * Arrow-key scrolling of the message list from a composer textarea.
 *
 * The composer keeps focus while reading, so a bare Up/Down there would only move
 * the caret inside the input. Once the caret is already on the first (Up) or last
 * (Down) line, the keypress has nowhere left to go inside the textarea and is
 * handed to the message list instead — the same behaviour in the GUI composer and
 * in the chat overlay of a PTY session.
 */

export interface ComposerArrowScrollEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type ComposerArrowScrollIntent = 'ignore' | 'scroll-up' | 'scroll-down';

const SCROLL_STEP_PX = 100;

export function resolveComposerArrowScroll(
  event: ComposerArrowScrollEvent,
  text: string,
  selectionStart: number,
): ComposerArrowScrollIntent {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return 'ignore';
  if (event.shiftKey || event.ctrlKey || event.metaKey) return 'ignore';

  const isUp = event.key === 'ArrowUp';
  const firstNewline = text.indexOf('\n');
  const lastNewline = text.lastIndexOf('\n');
  const onEdgeLine =
    firstNewline === -1 || (isUp ? selectionStart <= firstNewline : selectionStart > lastNewline);
  if (!onEdgeLine) return 'ignore';

  return isUp ? 'scroll-up' : 'scroll-down';
}

/** Scrolls the session's message list. Returns false when it is not mounted. */
export function scrollSessionMessages(
  sessionId: string,
  intent: Exclude<ComposerArrowScrollIntent, 'ignore'>,
): boolean {
  const container = document.querySelector(`[data-session-messages="${sessionId}"]`);
  if (!container) return false;
  container.scrollBy({ top: intent === 'scroll-up' ? -SCROLL_STEP_PX : SCROLL_STEP_PX });
  return true;
}
