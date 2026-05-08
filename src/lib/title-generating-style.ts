import type { CSSProperties } from 'react';

/**
 * Both the list view and the kanban view render the title-shimmer animation
 * (`.title-generating` in globals.css) on a session whose AI title is being
 * generated. CSS animations are normally local to each element, so when one
 * view re-mounts mid-generation (virtualized list, sort change, popout sync)
 * its animation restarts at phase 0 while the other keeps going — they drift
 * out of sync visually.
 *
 * Pinning the animation phase to a deterministic offset derived from the
 * session id makes both views show the same phase for the same session,
 * regardless of when each element entered the DOM.
 *
 * Animation duration is 1.2s — keep this constant in sync with globals.css.
 */
const TITLE_SHIMMER_DURATION_MS = 1200;

export function getTitleGeneratingStyle(sessionId: string): CSSProperties {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return { animationDelay: `-${hash % TITLE_SHIMMER_DURATION_MS}ms` };
}
