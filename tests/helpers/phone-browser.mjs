// The browser the phone-usability wave is measured in (#263).
//
// This sits beside `phone-viewport.mjs` rather than inside it on purpose: that file is
// the wave's shared *viewport* contract and several tickets touch it, so the launcher
// gets its own module and the two can move independently.

import { chromium } from '@playwright/test';

/**
 * Headful by default, which inverts the polarity the rest of tests/ uses.
 *
 * Every assertion in this wave is about what a person sees and touches at 360px, and
 * headless Chromium is the wrong witness for that: it rasterises WebGL through
 * SwiftShader, takes its device metrics from emulation rather than from a display, and
 * never paints to a compositor. That cost the wave twice in opposite directions — #256
 * was filed for a canvas-sizing defect that exists only under the emulation, and #260
 * was filed and closed unreproducible after a headless observation that a file would
 * not open.
 *
 * The variable stays `TESSERA_E2E_HEADED` rather than inventing a second spelling; only
 * its default moved. `TESSERA_E2E_HEADED=0` is the escape hatch for a machine with no
 * display, and a run that takes it is not evidence about layout.
 *
 * Read that default as wave-local. The non-mobile e2e files #263 deliberately left alone
 * — `git-base-ref`, `preparation-checklist`, `worktree-preparation` — still read the same
 * variable as `!== '1'`, so an explicit `0` or `1` means the same thing everywhere and
 * only an unset run differs: headful here, headless there.
 */
const PHONE_HEADLESS = process.env.TESSERA_E2E_HEADED === '0';

/**
 * Whether this machine needs a display variable before a window can open. Only X11 and
 * Wayland advertise one; macOS and Windows open a headful window with no such variable,
 * so the check below must not fire there or the whole wave becomes unrunnable on the two
 * platforms Tessera also ships to.
 */
const REQUIRES_DISPLAY_VARIABLE = process.platform === 'linux';

/**
 * Launch the browser this wave measures in. Fails loudly rather than falling back to
 * headless when no display is reachable, because a silent fallback hands back exactly
 * the kind of reading #256 and #260 were built on. A display-less run is still allowed —
 * it just has to say so, so that its results are read as what they are.
 *
 * @param {Parameters<import('@playwright/test').BrowserType['launch']>[0]} [options]
 */
export async function launchPhoneBrowser(options = {}) {
  const displayMissing = REQUIRES_DISPLAY_VARIABLE
    && !process.env.DISPLAY
    && !process.env.WAYLAND_DISPLAY;

  if (!PHONE_HEADLESS && displayMissing) {
    throw new Error(
      'Phone e2e runs headful and neither DISPLAY nor WAYLAND_DISPLAY is set. '
        + 'Give the run a display, or set TESSERA_E2E_HEADED=0 to opt out — '
        + 'a headless run is not evidence about what the phone renders.',
    );
  }
  return chromium.launch({ ...options, headless: PHONE_HEADLESS });
}
