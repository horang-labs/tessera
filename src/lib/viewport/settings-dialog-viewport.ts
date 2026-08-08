/**
 * The width at which the Settings dialog grows its sidebar (issue #266).
 *
 * The dialog is `md:flex-row` — below 768px its nav sits *above* the body as a
 * full-width band, and only from `md` up does it become the vertical column
 * beside it. That switch is the dialog's own, and it is not the Phone viewport
 * step (640px): a window between the two got neither control, so the nav fell
 * back to the horizontal strip #264 measured at 1040px inside a 658px box, with
 * three of the seven pages entirely off-screen behind a scrub nothing
 * advertises.
 *
 * Which control should own that band was measured before it was chosen. At
 * 700x880 the picker costs the dialog a 111.5px band (14% of its height, where
 * the strip it replaces cost 131px) and leaves the body the dialog's full 658px.
 * A column there would be `md:w-64`
 * — 16rem, so 256px at the default font scale and 352px at the largest — and
 * would leave the body 402px, or 231px at 640px with the largest scale, which
 * is narrower than the body a 360px phone gets. So the picker owns everything
 * below the sidebar step and the column owns everything from it up, and the two
 * meet exactly here: no width falls between them.
 *
 * Tailwind's `md` is `48rem`, and `rem` in a media query is the browser's
 * initial font size rather than the scaled root font — so this stays 768px at
 * every `FONT_SCALE_OPTIONS` value, as measured.
 */
export const SETTINGS_DIALOG_SIDEBAR_BREAKPOINT = 768;

/**
 * The band below that step as a media query, which is how the panel reads it.
 * `max-width` is inclusive, so it stops just below the breakpoint: 768px itself
 * is where `md:` applies and is therefore already the column.
 */
export const SETTINGS_DIALOG_STACKED_NAV_MEDIA_QUERY =
  `(max-width: ${SETTINGS_DIALOG_SIDEBAR_BREAKPOINT - 0.02}px)`;
