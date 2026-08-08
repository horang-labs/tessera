/**
 * The minimum hit area a control is given at Phone viewport (#259).
 *
 * `max-sm` is the Phone viewport step: 640px is Tailwind's `sm`, which is the
 * boundary `phone-viewport.ts` defines, so CSS-side work lands on exactly it.
 * Desktop non-regression is structural — above 640px these declarations do not
 * exist at all, so a pointer keeps the small chrome it always had.
 *
 * ## Why px and not `min-h-11`
 *
 * The root font is `calc(16px * var(--font-scale))` and the user picks the
 * scale from four options (`FONT_SCALE_OPTIONS`, 0.8125 to 1.375). So a `rem`
 * hit area is a *different number of pixels per user*: Tailwind's `-11` step
 * (2.75rem) is 44px at the default scale and 35.75px at 0.8125 — which is the
 * scale QA was on when it measured #243's keys at 36px against a 44px cost
 * (#262). A fingertip does not change size with a typography setting, so the
 * floor is stated in the unit it is claimed in. Being a *minimum*, a control
 * whose content outgrows it still grows.
 *
 * ## Only the box grows
 *
 * The glyph inside keeps the size the design gave it — the header has little
 * width to spare and the ticket's scope leaves icon sizing alone. That is why
 * this centres its content rather than stretching it: padding and hit area
 * grow, the icon does not.
 *
 * A control this is applied to needs a container that can accommodate it. A
 * row with a fixed `h-*` clips or overflows instead, so those rows carry
 * `max-sm:h-auto` and let the target decide the height.
 */
export const PHONE_TOUCH_TARGET_PX = 44;

/** Both axes — the default, for an icon-sized control. */
export const PHONE_TOUCH_TARGET =
  'max-sm:flex max-sm:items-center max-sm:justify-center max-sm:min-h-[44px] max-sm:min-w-[44px]';

/**
 * Height only, for a control that already spans its row. Forcing a minimum
 * width on one of those would fight the layout that already gives it more.
 */
export const PHONE_TOUCH_TARGET_HEIGHT = 'max-sm:min-h-[44px]';

/**
 * Width only, and a fixed width rather than a minimum — for the *column* a
 * target sits in rather than for the target itself.
 *
 * The project strip is one: `w-11` is the same 44 the floor asks for, but only
 * at the default font scale, and at 0.8125 the column is 35.75px so nothing
 * inside it can be 44px wide however the button is declared (#270). This states
 * the column in the unit the floor is claimed in, for the same reason
 * everything else here is in px.
 */
export const PHONE_TOUCH_TARGET_WIDTH = 'max-sm:w-[44px]';

/**
 * The same floor without the `max-sm` guard, for a control that does not exist
 * above the phone step's neighbourhood in the first place.
 *
 * Desktop non-regression is why the others are guarded, and a control that never
 * renders at desktop width has nothing to regress. The Settings section picker
 * is one: it replaces the stacked nav below 768px and is absent above it (#266).
 * Guarded, its rows measured 36px between 640 and 767 — the strip they replace
 * there is 60px tall, so the guard would have bought desktop nothing and cost a
 * finger a quarter of its target.
 */
export const ALWAYS_TOUCH_TARGET_HEIGHT = 'min-h-[44px]';
