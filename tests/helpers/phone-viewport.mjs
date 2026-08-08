// The one browser context the phone-usability wave is verified through (spec #241).
// Phone viewport is a width, not a device trait: 360px is the Galaxy Z Flip main
// display, and `hasTouch` is what makes touch-only code paths run at all.
//
// Each ticket keeps its own e2e file and imports this context, so the tickets can be
// built and merged independently without meeting in one file.

/**
 * The Z Flip's main display in CSS px — the whole screen, not the page's share of it
 * (#265). The wave was originally verified at this height, which handed every test
 * ~100px the device never gives the page.
 */
export const PHONE_SCREEN = { width: 360, height: 880 };

/**
 * What sits on that screen without being the page, in CSS px, from Android's standard dp
 * values rather than from a measurement on the user's phone. Android's status bar and
 * gesture navigation bar are there in both states below; Chrome's address bar is the
 * only one that goes away.
 *
 * The gesture bar is the softer of the three: three-button navigation takes 48 rather
 * than 24, which would leave the page 24px *shorter* again. So these numbers are the
 * roomier reading, and a layout that only just fits them has no margin at all.
 *
 * #265's acceptance criteria ask the user for the real numbers off their Flip. Until
 * those arrive these are a derivation, and the derivation is written out here so that a
 * measured number can replace exactly one line.
 */
const ANDROID_STATUS_BAR = 24;
const ANDROID_GESTURE_BAR = 24;
const CHROME_ADDRESS_BAR = 56;

/**
 * The wave's default, and the honest one: Playwright's `viewport` is the *content* area
 * — `window.innerHeight`, what the page is handed — so it has to be the screen minus
 * Chrome's furniture. The address-bar-visible state is the smaller of the two real
 * states, and a layout that only fits the taller one is broken for the user right up
 * until they scroll.
 */
export const PHONE_VIEWPORT = {
  width: PHONE_SCREEN.width,
  height: PHONE_SCREEN.height - ANDROID_STATUS_BAR - CHROME_ADDRESS_BAR - ANDROID_GESTURE_BAR,
};

/**
 * The same phone after the address bar has scrolled away. Kept as a second case rather
 * than as the default: both states are real and the page has to survive the transition
 * between them, but this is the one the user does not start in.
 */
export const PHONE_VIEWPORT_ADDRESS_BAR_HIDDEN = {
  width: PHONE_SCREEN.width,
  height: PHONE_SCREEN.height - ANDROID_STATUS_BAR - ANDROID_GESTURE_BAR,
};

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {Parameters<import('@playwright/test').Browser['newContext']>[0]} [options]
 */
export async function createPhoneContext(browser, options = {}) {
  return createContextAt(browser, PHONE_VIEWPORT, options);
}

/**
 * The phone with the address bar scrolled away. Same context in every other respect, so
 * a test can take a height-shaped verdict in both states without restating the rest.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {Parameters<import('@playwright/test').Browser['newContext']>[0]} [options]
 */
export async function createPhoneContextWithAddressBarHidden(browser, options = {}) {
  return createContextAt(browser, PHONE_VIEWPORT_ADDRESS_BAR_HIDDEN, options);
}

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {{ width: number, height: number }} viewport
 * @param {Parameters<import('@playwright/test').Browser['newContext']>[0]} options
 */
async function createContextAt(browser, viewport, options) {
  return browser.newContext({
    ...options,
    viewport,
    hasTouch: true,
  });
}
