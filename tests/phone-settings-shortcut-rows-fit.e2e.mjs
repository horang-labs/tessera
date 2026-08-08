/**
 * The General page's keyboard-shortcut rows fit 360px (issue #268).
 *
 * At the phone viewport and font scale 1.375 the rows overflowed their card: the Reset
 * buttons ended at x=373 inside a 304px body — 49px into the dialog's own scroller, and
 * past the 360px screen entirely. The page never scrolled sideways, so the control was
 * unreachable rather than visibly broken, which is why #264 could only note it.
 *
 * One scale (1.375, where it is worst), one height, and a desktop check because the rows
 * are the same component above the phone step. Scales 0.8125 and 1, the address-bar-hidden
 * height and tapping Reset were all measured while fixing this — the numbers are on the
 * ticket, and none of them fails independently of the assertions below.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { startDevServer, putSettings } from './helpers/dev-server.mjs';

/** The extreme of `FONT_SCALE_OPTIONS` where the defect is worst; the default has slack. */
const LARGEST_FONT_SCALE = 1.375;
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
/** A rect edge and a padding edge from the same layout disagree in the last fraction. */
const EDGE_TOLERANCE = 1;

const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-settings-shortcuts-e2e');
let dev = null;
let browser = null;

/** Opens Settings on General, scrolled to the shortcuts card. */
async function openShortcutsCard({ phone, fontScale }) {
  await putSettings(dev, { fontSize: fontScale });

  const options = { extraHTTPHeaders: { 'x-tessera-app-secret': dev.appSecret } };
  const context = phone
    ? await createPhoneContext(browser, options)
    : await browser.newContext({ ...options, viewport: DESKTOP_VIEWPORT, hasTouch: false });
  // The server value survives hydration; this one makes the first paint already match.
  await context.addInitScript((scale) => {
    localStorage.setItem('tessera:settings', JSON.stringify({
      state: { settings: { fontSize: scale, theme: 'light' } }, version: 0,
    }));
  }, fontScale);

  const page = await context.newPage();
  // 'load' rather than 'domcontentloaded': an unstyled control measures as its content.
  await page.goto(`${dev.origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
  // This test authenticates HTTP with the app-secret header, which a browser cannot attach
  // to a WebSocket upgrade. Keep the expected dev-only overlay off the controls.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.getByRole('button', { name: 'Settings' }).click();
  const card = page.getByTestId('settings-section-general-shortcuts');
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  // Centred rather than just scrolled into view: the card is the last one on the page, so
  // `scrollIntoViewIfNeeded` stops with a single row showing and the screenshot — which is
  // how a failure gets looked at — would show one row out of seventeen.
  await card.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  // The font scale has to have settled before anything is measured.
  await page.waitForTimeout(300);
  return { context, page };
}

/** The card's content edge, and per row its Reset button and whichever child reaches furthest. */
async function measure(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const card = document.querySelector('[data-testid="settings-section-general-shortcuts"]');
    const body = document.querySelector('[data-testid="settings-content"]');
    const style = getComputedStyle(card);
    const rect = card.getBoundingClientRect();
    return {
      // The card's padding is what the rows may fill; a control on the padding edge has
      // already left the space it was given.
      cardRight: round(rect.right - parseFloat(style.paddingRight)
        - parseFloat(style.borderRightWidth)),
      bodyOverflow: body.scrollWidth - body.clientWidth,
      rootFontSize: round(parseFloat(getComputedStyle(document.documentElement).fontSize)),
      innerWidth: window.innerWidth,
      rows: Array.from(card.querySelectorAll('[data-testid^="shortcut-row-"]')).map((row) => {
        const id = row.getAttribute('data-testid').replace('shortcut-row-', '');
        const reset = row.querySelector(`[data-testid="shortcut-reset-${id}"]`)
          ?.getBoundingClientRect();
        // The furthest-reaching child, named: a bare overflow number cannot say whose it is.
        const worst = Array.from(row.children)
          .map((child) => {
            const childRect = child.getBoundingClientRect();
            return {
              what: child.getAttribute('data-testid') ?? child.tagName.toLowerCase(),
              text: (child.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
              right: round(childRect.right),
              width: round(childRect.width),
            };
          })
          .filter((child) => child.width > 0)
          .sort((a, b) => b.right - a.right)[0];
        return {
          id,
          worst,
          reset: reset ? {
            left: round(reset.left), right: round(reset.right),
            width: round(reset.width), height: round(reset.height),
          } : null,
        };
      }),
    };
  });
}

/**
 * The verdict. Stated per control rather than on the body's overflow alone: a card that
 * grew its own scroller would zero the overflow and still hide the button. And a row made
 * to fit by dropping what left it is a regression, not a fix, so Reset is also checked for
 * still being there, non-zero and on screen.
 */
function assertRowsFit(measurement, label) {
  assert.ok(measurement.rows.length > 0, `${label}: no shortcut rows rendered`);
  // A row with nothing measurable in it is its own failure, and reading `worst` off one
  // would throw a TypeError instead of saying so.
  const empty = measurement.rows.filter((row) => !row.worst).map((row) => row.id);
  assert.deepEqual(empty, [], `${label}: rows rendered no visible control: ${empty.join(', ')}`);

  const escapees = measurement.rows
    .filter((row) => row.worst.right - measurement.cardRight > EDGE_TOLERANCE)
    .map((row) => `${row.id}/${row.worst.what} "${row.worst.text}" ends at ${row.worst.right},`
      + ` ${Math.round(row.worst.right - measurement.cardRight)}px past ${measurement.cardRight}`);
  assert.deepEqual(escapees, [], `${label}: controls left the card:\n    ${escapees.join('\n    ')}`);
  assert.ok(
    measurement.bodyOverflow <= EDGE_TOLERANCE,
    `${label}: the General page's body slides sideways by ${measurement.bodyOverflow}px`,
  );
  for (const { id, reset } of measurement.rows) {
    assert.ok(reset, `${label}: the ${id} row lost its Reset button`);
    assert.ok(
      reset.width > 0 && reset.height > 0 && reset.left >= 0
        && reset.right <= measurement.innerWidth + EDGE_TOLERANCE,
      `${label}: the ${id} row's Reset is ${reset.width}x${reset.height} at`
        + ` ${reset.left}→${reset.right}, outside 0→${measurement.innerWidth}`,
    );
  }
}

try {
  await fs.mkdir(artifactDir, { recursive: true });
  dev = await startDevServer({ dataDirPrefix: 'tessera-settings-shortcuts-data-' });
  browser = await launchPhoneBrowser();

  for (const [label, phone, fontScale] of [
    [`phone${PHONE_VIEWPORT.height}-scale-${LARGEST_FONT_SCALE}`, true, LARGEST_FONT_SCALE],
    ['desktop-scale-1', false, 1],
  ]) {
    const { context, page } = await openShortcutsCard({ phone, fontScale });
    try {
      const measurement = await measure(page);
      assert.ok(
        Math.abs(measurement.rootFontSize - 16 * fontScale) <= 0.5,
        `${label}: root font is ${measurement.rootFontSize}px — the scale never applied`,
      );
      // Before the assertions: a run that throws first leaves nothing to look at.
      await page.screenshot({ path: path.join(artifactDir, `${label}.png`) });
      assertRowsFit(measurement, label);
      console.log(`ok ${label}: ${measurement.rows.length} rows inside ${measurement.cardRight},`
        + ` body overflow ${measurement.bodyOverflow}px, root font ${measurement.rootFontSize}px`);
    } finally {
      await context.close();
    }
  }
  console.log(`\nartifacts: ${artifactDir}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (dev) await dev.stop();
}
