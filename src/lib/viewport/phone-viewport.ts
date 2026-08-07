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

export function isPhoneViewportWidth(width: number): boolean {
  return width < PHONE_VIEWPORT_BREAKPOINT;
}

/**
 * The same step as a media query, for `matchMedia`. `max-width` is inclusive,
 * so it stops just below the breakpoint: 640px itself is where `sm:` applies
 * and is therefore not a Phone viewport.
 */
export const PHONE_VIEWPORT_MEDIA_QUERY = `(max-width: ${PHONE_VIEWPORT_BREAKPOINT - 0.02}px)`;
