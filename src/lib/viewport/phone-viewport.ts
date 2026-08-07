/**
 * Phone viewport — a viewport narrower than 640px (CONTEXT.md).
 *
 * A new step below the pre-existing Compact viewport (<1024px, defined in
 * `chat-layout.tsx`). Compact viewport also covers tablets and desktop windows
 * a user merely narrowed, so behaviour meant for a phone must not hang off it.
 * 640px is Tailwind's `sm`, so CSS-side work uses the `sm:` prefix and lands on
 * exactly this boundary.
 *
 * Width alone decides it. A touchscreen desktop is not a Phone viewport.
 */
export const PHONE_VIEWPORT_BREAKPOINT = 640;

/**
 * The step as a media query, which is how `usePhoneViewport` reads it.
 * `max-width` is inclusive, so it stops just below the breakpoint: 640px itself
 * is where `sm:` applies and is therefore not a Phone viewport.
 */
export const PHONE_VIEWPORT_MEDIA_QUERY = `(max-width: ${PHONE_VIEWPORT_BREAKPOINT - 0.02}px)`;

/**
 * One reading of the step, for callers outside React. Components subscribe
 * through `usePhoneViewport` instead.
 *
 * Desktop non-regression is the point of the `false` fallbacks: without a window
 * and without `matchMedia`, this is not a phone.
 */
export function isPhoneViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_VIEWPORT_MEDIA_QUERY).matches;
}
