/**
 * Keeping a `position: fixed` overlay inside the viewport.
 *
 * The arithmetic here was written for the collection quick-create sheet and lived inside
 * its `updateAnchoredPosition`. It is extracted rather than copied: the notification
 * family grew the same defect precisely because it had its own positioning code, and a
 * second clamp would put the divergence one layer down instead of removing it.
 */

/** How close to an edge a clamped overlay is allowed to come. */
export const ANCHORED_VIEWPORT_MARGIN = 12;

interface AnchoredSideInput {
  /** Left edge of the anchor, in viewport coordinates. */
  anchorLeft: number;
  /** Right edge of the anchor, in viewport coordinates. */
  anchorRight: number;
  elementWidth: number;
  viewportWidth: number;
  /** Distance kept between the anchor and the element. */
  gap: number;
  margin?: number;
}

/**
 * The `left` for an overlay that opens beside its anchor: to the right of it by
 * preference, flipped to the left when the right edge is short, and pushed back against
 * the right margin when neither side has room.
 *
 * Inert wherever the preferred position already fits, which is every desktop layout.
 */
export function resolveAnchoredSideLeft({
  anchorLeft,
  anchorRight,
  elementWidth,
  viewportWidth,
  gap,
  margin = ANCHORED_VIEWPORT_MARGIN,
}: AnchoredSideInput): number {
  const left = anchorRight + gap;
  if (left + elementWidth <= viewportWidth - margin) return left;

  const flipped = anchorLeft - elementWidth - gap;
  if (flipped >= margin) return flipped;

  return Math.max(margin, viewportWidth - elementWidth - margin);
}

interface AnchoredAlignedInput {
  /** Right edge of the anchor, in viewport coordinates. */
  anchorRight: number;
  elementWidth: number;
  viewportWidth: number;
  margin?: number;
}

/**
 * The `left` for an overlay whose right edge is aligned to its anchor's, held inside both
 * viewport margins. Inert wherever the aligned position already fits.
 */
export function resolveAnchoredAlignedLeft({
  anchorRight,
  elementWidth,
  viewportWidth,
  margin = ANCHORED_VIEWPORT_MARGIN,
}: AnchoredAlignedInput): number {
  const maxLeft = Math.max(margin, viewportWidth - elementWidth - margin);
  return Math.min(Math.max(margin, anchorRight - elementWidth), maxLeft);
}
