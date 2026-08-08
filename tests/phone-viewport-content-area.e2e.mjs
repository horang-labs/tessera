// Ticket #265 — the shared phone context is the page's content area, not the screen.
//
// The wave's fourteen e2e files all take their verdicts inside a context built by
// `createPhoneContext`, so the height that context hands the page is the wave's single
// most load-bearing number. It was 880, the Z Flip's whole screen, while Playwright's
// `viewport` is `window.innerHeight` — the page's share of it. Every height-shaped
// assertion in the wave was therefore taken with ~100px the device never gives.
//
// The seam here is what a real page reports, not what the module exports: this opens a
// context, loads a document into it and reads `window.innerHeight` back. A test that
// re-derived the constant from the same subtraction the helper does would pass by
// construction. The numbers below come from the device instead — Android's status bar
// and gesture bar and Chrome's address bar, the same figures issue #265 states — so the
// helper and the test can disagree.
//
// What this file does not settle:
//   * the real height on the user's phone. No harness can report it; #265's acceptance
//     criteria carry it as a device step.
//   * the address bar actually retracting. Playwright cannot animate it; the taller
//     context is that end state, not the transition (#245 owns the transition).
//   * whether any given layout fits at the shorter height. That is each layout's own
//     ticket, per #265's scope boundary.
import assert from 'node:assert/strict';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import {
  PHONE_SCREEN,
  createPhoneContext,
  createPhoneContextWithAddressBarHidden,
} from './helpers/phone-viewport.mjs';

/** The Z Flip main display in CSS px, from the device spec rather than from the helper. */
const FLIP_SCREEN_HEIGHT = 880;

/**
 * Android's own furniture, which is on screen in both of the states below: the status
 * bar at the top and the gesture navigation bar at the bottom, 24dp each. Three-button
 * navigation takes 48 rather than 24 and would make the page shorter still.
 */
const ANDROID_BARS = 24 + 24;

/** Chrome's address bar — the only thing that differs between the two states. */
const ADDRESS_BAR_HEIGHT = 56;

/**
 * What the page should be handed in each state, derived here from the device's dp
 * budget rather than read back out of the helper. These are the numbers that let the
 * test disagree with the module it is testing; if the helper's own subtraction changes,
 * these do not follow it.
 */
const PAGE_WITH_ADDRESS_BAR_HIDDEN = FLIP_SCREEN_HEIGHT - ANDROID_BARS;
const PAGE_WITH_ADDRESS_BAR_SHOWING = PAGE_WITH_ADDRESS_BAR_HIDDEN - ADDRESS_BAR_HEIGHT;

const browser = await launchPhoneBrowser();
const results = [];
try {
  testTheHelperStillKnowsWhichScreenItIsSubtractingFrom();
  await testTheDefaultContextIsTheContentArea();
  await testTheTallContextIsTheSamePhoneWithoutItsAddressBar();
  await testBothContextsStayTouchOnlyAt360();
} finally {
  await browser.close().catch(() => undefined);
}
console.log(results.join('\n'));
console.log('ok — the shared phone context measured as the page sees it');

/**
 * The regression this ticket exists for. A context that hands the page the full 880 is
 * describing a screen, and the page never gets the screen.
 */
async function testTheDefaultContextIsTheContentArea() {
  const { context, height } = await measureContext(createPhoneContext);

  try {
    assert.ok(
      height < FLIP_SCREEN_HEIGHT,
      `the default phone context handed the page the whole ${FLIP_SCREEN_HEIGHT}px screen`
        + ` (${height}px) — Playwright's viewport is the content area, so Chrome's`
        + ' furniture has to come out of it first',
    );
    assert.equal(
      height,
      PAGE_WITH_ADDRESS_BAR_SHOWING,
      `the default phone context should hand the page the ${FLIP_SCREEN_HEIGHT}px screen`
        + ` less Android's two bars (${ANDROID_BARS}px) and Chrome's address bar`
        + ` (${ADDRESS_BAR_HEIGHT}px)`,
    );
    results.push(`default context: page gets ${height}px of the ${FLIP_SCREEN_HEIGHT}px screen`);
  } finally {
    await context.close();
  }
}

/**
 * The taller state stays reachable — both are real, and the address bar is the only
 * thing that separates them.
 */
async function testTheTallContextIsTheSamePhoneWithoutItsAddressBar() {
  const { context, height } = await measureContext(createPhoneContextWithAddressBarHidden);

  try {
    assert.equal(
      height,
      PAGE_WITH_ADDRESS_BAR_HIDDEN,
      `with the address bar gone the page should get the ${FLIP_SCREEN_HEIGHT}px screen less`
        + ` Android's two bars (${ANDROID_BARS}px), which do not scroll away`,
    );
    assert.ok(
      height < FLIP_SCREEN_HEIGHT,
      `even with the address bar gone the page never gets the whole ${FLIP_SCREEN_HEIGHT}px`
        + ` screen (${height}px): Android keeps its status and gesture bars`,
    );
    results.push(`address-bar-hidden context: page gets ${height}px`);
  } finally {
    await context.close();
  }
}

/**
 * The screen the helper subtracts from is still the phone this wave is about. Separate
 * from the two measurements above because it is the one claim here that a module
 * constant can settle on its own.
 */
function testTheHelperStillKnowsWhichScreenItIsSubtractingFrom() {
  assert.deepEqual(
    PHONE_SCREEN,
    { width: 360, height: FLIP_SCREEN_HEIGHT },
    'the helper should still be working from the Galaxy Z Flip main display',
  );
}

/**
 * Neither height may cost the wave the two traits that made this one context worth
 * sharing: 360px is what `PHONE_VIEWPORT_BREAKPOINT` is built around, and `hasTouch` is
 * what makes the touch-only code paths run at all.
 */
async function testBothContextsStayTouchOnlyAt360() {
  for (const [label, factory] of [
    ['default', createPhoneContext],
    ['address-bar-hidden', createPhoneContextWithAddressBarHidden],
  ]) {
    const context = await factory(browser);
    try {
      const page = await context.newPage();
      await page.goto('about:blank');
      const traits = await page.evaluate(() => ({
        width: window.innerWidth,
        touchPoints: navigator.maxTouchPoints,
        hovers: window.matchMedia('(hover: hover)').matches,
      }));
      assert.equal(traits.width, 360, `the ${label} context must stay 360px wide`);
      assert.ok(traits.touchPoints > 0, `the ${label} context must report touch`);
      assert.equal(traits.hovers, false, `the ${label} context must not advertise hover`);
    } finally {
      await context.close();
    }
  }
}

/** @param {(browser: import('@playwright/test').Browser) => Promise<import('@playwright/test').BrowserContext>} factory */
async function measureContext(factory) {
  const context = await factory(browser);
  const page = await context.newPage();
  // A real document, not the context options: `viewport` is a request until a page
  // exists, and it is the page's `innerHeight` the wave measures against.
  await page.goto('about:blank');
  const height = await page.evaluate(() => window.innerHeight);
  return { context, height };
}
