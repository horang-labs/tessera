/**
 * Selected segment of a segmented control (List/Board, All/Running).
 * A lighter neutral fill plus an inset hairline ring keeps the selection
 * readable on the dark track; the plain `--sidebar-active` step was too close
 * to the track colour to see.
 */
export const SEGMENTED_CONTROL_SELECTED =
  'bg-[color-mix(in_srgb,var(--text-primary)_16%,var(--input-bg))] text-(--text-primary) shadow-sm shadow-black/30 ring-1 ring-inset ring-[color-mix(in_srgb,var(--text-primary)_14%,transparent)]';
