// The browser the phone-usability wave is measured in (#263).
//
// This sits beside `phone-viewport.mjs` rather than inside it on purpose: that file is
// the wave's shared *viewport* contract and several tickets touch it, so the launcher
// gets its own module and the two can move independently.

import { chromium } from '@playwright/test';

/**
 * Regression tests must not open a focus-stealing browser window by default. A headed
 * run remains available for deliberate visual QA through `TESSERA_E2E_HEADED=1`.
 */
const PHONE_HEADLESS = process.env.TESSERA_E2E_HEADED !== '1';

/**
 * Whether this machine needs a display variable before a window can open. Only X11 and
 * Wayland advertise one; macOS and Windows open a headful window with no such variable,
 * so the check below must not fire there or the whole wave becomes unrunnable on the two
 * platforms Tessera also ships to.
 */
const REQUIRES_DISPLAY_VARIABLE = process.platform === 'linux';

/**
 * Launch the browser this wave measures in. An explicitly requested headed run fails
 * loudly when no display is available instead of silently changing its requested mode.
 *
 * @param {Parameters<import('@playwright/test').BrowserType['launch']>[0]} [options]
 */
export async function launchPhoneBrowser(options = {}) {
  const displayMissing = REQUIRES_DISPLAY_VARIABLE
    && !process.env.DISPLAY
    && !process.env.WAYLAND_DISPLAY;

  if (!PHONE_HEADLESS && displayMissing) {
    throw new Error(
      'TESSERA_E2E_HEADED=1 was requested but neither DISPLAY nor WAYLAND_DISPLAY is set. '
        + 'Give the run a display or omit TESSERA_E2E_HEADED for the headless default.',
    );
  }
  return chromium.launch({ ...options, headless: PHONE_HEADLESS });
}
