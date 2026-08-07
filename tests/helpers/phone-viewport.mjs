// The one browser context the phone-usability wave is verified through (spec #241).
// Phone viewport is a width, not a device trait: 360x880 is the Galaxy Z Flip main
// display, and `hasTouch` is what makes touch-only code paths run at all.
//
// Each ticket keeps its own e2e file and imports this context, so the tickets can be
// built and merged independently without meeting in one file.

export const PHONE_VIEWPORT = { width: 360, height: 880 };

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {Parameters<import('@playwright/test').Browser['newContext']>[0]} [options]
 */
export async function createPhoneContext(browser, options = {}) {
  return browser.newContext({
    ...options,
    viewport: PHONE_VIEWPORT,
    hasTouch: true,
  });
}
