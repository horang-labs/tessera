/**
 * Every Settings page is reachable at Phone viewport (issue #264).
 *
 * QA measured the Settings dialog's section strip at 360x880 and found 1029px
 * of tabs in a 332px box: two of the seven pages on screen, five off it,
 * reachable only by scrubbing a strip that said nothing about scrolling. Remote
 * access and Models — the two pages someone opens *because* they are on a phone
 * — were among the five.
 *
 * Wrapping the strip onto rows was measured first and rejected here on height,
 * which is why the fix is a picker: see phase 0, which keeps that measurement so
 * the decision is not folklore.
 *
 * What this file measures, on the controls' own elements and never on a class
 * name:
 *
 *   0. The height budget the wrapped-strip option had to fit, at the height the
 *      device really gives the page.
 *   1. Phone viewport (360x776, touch), default font scale: the strip is gone,
 *      one picker names the page you are on, opening it puts all seven pages
 *      wholly inside the viewport with nothing hidden in either axis, each row
 *      is a 44px touch target, tapping a row lands on its page, and the page
 *      never scrolls sideways.
 *   2. The same at both ends of `FONT_SCALE_OPTIONS` (0.8125 and 1.375). The
 *      rows are `rem`-declared and the root font is `calc(16px * --font-scale)`,
 *      so the default scale carries slack that hides a layout which only just
 *      fits.
 *   3. Desktop width (1280x900, no touch): the same seven tabs, same order,
 *      still one column in the sidebar, and no picker. Nothing above the Phone
 *      viewport step may move.
 *   4. Phases 1 and 2 again with the address bar scrolled away, which is the
 *      other height the same phone really has. Phases 0-3 take the smaller of
 *      the two, so this is the transition, not a second guess at the default.
 *   5. One width in the band between the Phone viewport step and the dialog's own
 *      column step, 640-767px (#266). The picker was phone-only and the column is
 *      `md:`, so these widths got neither and fell back to the strip: 1040px of
 *      tabs in a 658px box at 700px wide, three of the seven pages off-screen.
 *      Plus 768px itself, so no width sits between the two controls.
 *
 * The server runs from the repository itself rather than a copied app root:
 * every assertion here is a measured box and Tailwind only generates its
 * utility layer for the tree it is pointed at, so a copy serves the page
 * unstyled and every box measures as its content (#252).
 *
 * What this file cannot settle: whether the picker is *discoverable* by someone
 * who has never seen the screen. Playwright finds a control whether or not a
 * thumb would. That is on the issue's acceptance criteria as a device step.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1,2 while iterating.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  PHONE_VIEWPORT,
  PHONE_VIEWPORT_ADDRESS_BAR_HIDDEN,
  createPhoneContext,
  createPhoneContextWithAddressBarHidden,
} from './helpers/phone-viewport.mjs';

/** A pointer-driven window, which is what must not regress. */
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/**
 * One width inside the band the two controls used to leave uncovered (#266).
 * 880px tall because that is the whole Z Flip screen — a window this wide is the
 * phone turned over or a narrowed desktop, not the page inside Chrome's
 * furniture, so `PHONE_VIEWPORT`'s height derivation does not apply here.
 *
 * One width and one scale: the strip overflowed at every width in the band and
 * at every font scale (640/700/767 at 1 and 1.375 are in the ticket's report as
 * numbers), so a sweep here would re-assert the same claim six times.
 */
const BAND_VIEWPORT = { width: 700, height: 880 };

/**
 * The first width at which the dialog grows its sidebar
 * (`SETTINGS_DIALOG_SIDEBAR_BREAKPOINT`). Asserted as the band's far edge so the
 * two controls are shown to meet rather than assumed to.
 */
const SIDEBAR_STEP_WIDTH = 768;

/** The floor a finger needs, in CSS px (`PHONE_TOUCH_TARGET_PX`, #259). */
const MIN_TOUCH_TARGET = 44;

/** Both ends of the scale the user picks from (`FONT_SCALE_OPTIONS`). */
const SMALLEST_FONT_SCALE = 0.8125;
const LARGEST_FONT_SCALE = 1.375;

/**
 * The most of the dialog the section nav may spend on itself.
 *
 * This is the constraint that chose the presentation. A nav that eats the
 * dialog has traded a navigation defect for an unusable page, which is what the
 * ticket says not to do — and at the height a phone really has, the dialog is
 * 698px, so a four-row wrapped strip at 333px is half of it.
 *
 * Stated against the nav rather than against the body on purpose: the body's
 * share also depends on the title block, which at the largest font scale is
 * 463px all by itself (a separate defect, not this ticket's). Holding the nav to
 * its own number is what this change can actually be held to.
 */
const MAX_NAV_SHARE = 0.25;

/**
 * What the rejected wrapped strip measured, recorded rather than re-measured:
 * `max-sm:grid max-sm:grid-cols-2` on the nav with labels wrapping instead of
 * truncating, seven tabs over four rows, 2026-08-08 on this build. The wrapped
 * CSS is not in the tree, so phase 0 cannot re-derive this — see its comment for
 * exactly what that means the phase does and does not catch.
 */
const WRAPPED_NAV_HEIGHT = 333;

/**
 * The seven pages, in the order the nav declares them, each with a testid only
 * its own page renders. Reaching a page means its content arrived, not that a
 * control reported itself pressed.
 */
const SECTIONS = [
  { id: 'general', content: 'settings-section-general-execution-mode' },
  { id: 'project', content: 'settings-section-project-preparation' },
  { id: 'appearance', content: 'settings-section-appearance' },
  { id: 'models', content: 'settings-section-models' },
  { id: 'remote-access', content: 'settings-section-remote-access' },
  { id: 'development', content: 'settings-section-development-cli-status' },
  { id: 'git', content: 'settings-section-git' },
];

// Headful only: a headless run renders through SwiftShader and reports emulated
// device metrics, which invented one defect in this wave already (#256).
const headless = false;
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-settings-nav-e2e');
const selectedPhases = process.env.TESSERA_E2E_PHASES
  ? new Set(process.env.TESSERA_E2E_PHASES.split(',').map((value) => value.trim()))
  : null;

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-settings-nav-data-'));
const serverOutput = [];
let server = null;
let browser = null;
let appSecret = null;
const results = [];

const logs = () => serverOutput.join('');

// ---------------------------------------------------------------- harness ---

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const selected = address.port;
  await new Promise((resolve, reject) => listener.close((error) => (
    error ? reject(error) : resolve()
  )));
  return selected;
}

async function startServer() {
  const env = { ...process.env };
  // This suite may itself be running inside Tessera; nothing about the host
  // app's session may leak into the server under test.
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
    'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID', '__CFBundleIdentifier',
  ]) {
    delete env[key];
  }

  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 400) serverOutput.shift();
    });
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      });
      if (response.ok) return;
    } catch {
      // Next is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${logs()}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    if (process.platform === 'win32') server.kill('SIGTERM');
    else process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server = null;
}

// --------------------------------------------------------------------- ui ---

/**
 * The font scale lives on the server, and `ThemeInitializer` writes
 * `--font-scale` from the loaded settings — so seeding localStorage alone gets
 * overwritten the moment the store hydrates. Both are set: the server so the
 * scale survives hydration, localStorage so the first paint already matches.
 *
 * @param {number} scale One of `FONT_SCALE_OPTIONS`.
 */
async function setFontScale(scale) {
  const response = await fetch(`${origin}/api/settings`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      // Mutating routes check the origin; `fetch` does not set one for us.
      origin,
    },
    body: JSON.stringify({ fontSize: scale }),
  });
  assert.equal(response.ok, true, `could not set the font scale: ${await response.text()}`);
}

/**
 * Opens the app with Settings showing.
 *
 * @param {object} options
 * @param {'phone'|'phone-address-bar-hidden'|'desktop'|{width: number, height: number}}
 *   options.viewport A named case, or an explicit touch viewport for the widths
 *   between the phone step and the dialog's column step.
 * @param {number} options.fontScale One of `FONT_SCALE_OPTIONS`. Also seeded
 *   where the FOUC-prevention script in `layout.tsx` reads it, so the root font
 *   size is already right on the first paint.
 */
async function openSettingsPage({ viewport, fontScale }) {
  await setFontScale(fontScale);
  const options = { extraHTTPHeaders: { 'x-tessera-app-secret': appSecret } };
  const context = typeof viewport === 'object'
    ? await browser.newContext({ ...options, viewport, hasTouch: true })
    : viewport === 'phone'
      ? await createPhoneContext(browser, options)
      : viewport === 'phone-address-bar-hidden'
        ? await createPhoneContextWithAddressBarHidden(browser, options)
        : await browser.newContext({ ...options, viewport: DESKTOP_VIEWPORT, hasTouch: false });

  await context.addInitScript((scale) => {
    localStorage.setItem('tessera:settings', JSON.stringify({
      state: { settings: { fontSize: scale, theme: 'light' } },
      version: 0,
    }));
  }, fontScale);

  const page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));

  // 'load' rather than 'domcontentloaded': every box measured here is a styled
  // box, and an unstyled control measures as its content.
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 90_000 });

  // This test authenticates HTTP with the app-secret header, which a browser
  // cannot attach to a WebSocket upgrade. Keep the expected dev-only overlay
  // from covering the controls being measured.
  await page.addStyleTag({
    content: 'nextjs-portal { pointer-events: none !important; display: none !important; }',
  });
  await page.evaluate(() => {
    const removeDevOverlay = () => {
      document.querySelectorAll('nextjs-portal').forEach((portal) => portal.remove());
    };
    removeDevOverlay();
    new MutationObserver(removeDevOverlay).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-modal').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('settings-section-general-execution-mode')
    .waitFor({ state: 'visible', timeout: 30_000 });
  // The font scale has to have settled before anything is measured.
  await page.waitForTimeout(300);

  return { context, page };
}

/**
 * Everything measured about the dialog in one pass: the picker and its list at
 * the Phone viewport, the strip above it, and where the dialog's height went.
 */
async function measureDialog(page) {
  return page.evaluate((ids) => {
    const round = (value) => Math.round(value * 100) / 100;
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: round(rect.left),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        width: round(rect.width),
        height: round(rect.height),
      };
    };
    const scroll = (element) => (element ? {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    } : null);

    const modal = document.querySelector('[data-testid="settings-modal"]');
    const content = document.querySelector('[data-testid="settings-content"]');
    const aside = modal?.querySelector('aside') ?? null;
    // Where the dialog's height goes: the nav band, the title block, the body.
    const header = content?.previousElementSibling ?? null;
    const strip = document.querySelector('[data-testid="settings-nav"]');
    const trigger = document.querySelector('[data-testid="settings-section-picker"]');
    const list = document.querySelector('[data-testid="settings-section-picker-list"]');

    // Whichever ancestor of the strip actually overflows is the one hiding
    // pages, so every scrollable ancestor is reported.
    const stripScrollers = [];
    for (let node = strip; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (!/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
      stripScrollers.push({
        testId: node.getAttribute('data-testid'),
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        ...scroll(node),
      });
    }

    return {
      tabs: ids.map((id) => {
        const element = document.querySelector(`[data-testid="settings-nav-${id}"]`);
        return { id, box: element ? box(element) : null };
      }),
      stripBox: strip ? box(strip) : null,
      stripScroll: scroll(strip),
      stripScrollers,
      hasStrip: Boolean(strip),
      triggerBox: trigger ? box(trigger) : null,
      triggerText: trigger ? trigger.innerText.replace(/\s+/g, ' ').trim() : null,
      triggerExpanded: trigger ? trigger.getAttribute('aria-expanded') : null,
      triggerPopup: trigger ? trigger.getAttribute('aria-haspopup') : null,
      // The chevron is the whole affordance, so its direction is asserted rather
      // than eyeballed — at 16px a rotated chevron and an unrotated one are hard
      // to tell apart in a screenshot.
      // `:scope >` on purpose: the active page's own icon is an `svg` too, but it
      // is nested in a span, and the chevron is the trigger's direct child.
      // Both properties: Tailwind v4's `rotate-*` writes the standalone `rotate`
      // property, not `transform`, so reading only `transform` reports 'none'
      // whichever way the chevron points.
      triggerChevronTurn: trigger
        ? (() => {
          const style = getComputedStyle(trigger.querySelector(':scope > svg'));
          return `${style.transform}/${style.rotate}`;
        })()
        : null,
      listBox: list ? box(list) : null,
      listScroll: scroll(list),
      asideBox: aside ? box(aside) : null,
      headerBox: header ? box(header) : null,
      contentBox: content ? box(content) : null,
      contentScroll: scroll(content),
      // If the body does slide sideways, name what is doing it: the body is not
      // this ticket's, and a bare number cannot say whose it is.
      contentOverflowers: content
        ? Array.from(content.querySelectorAll('*'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.right > content.getBoundingClientRect().right + 1;
          })
          .filter((element) => !element.querySelector('*'))
          .slice(0, 6)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const owner = element.closest('[data-testid]');
            return {
              tag: element.tagName.toLowerCase(),
              owner: owner?.getAttribute('data-testid') ?? null,
              text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
              right: round(rect.right),
            };
          })
        : [],
      modalBox: modal ? box(modal) : null,
      // The dialog draws a 1px border, so its inner width is what the body can
      // actually fill.
      modalClientWidth: modal ? modal.clientWidth : null,
      rootFontSize: round(parseFloat(getComputedStyle(document.documentElement).fontSize)),
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    };
  }, SECTIONS.map((section) => section.id));
}

function describeTabs(measurement) {
  return measurement.tabs
    .map(({ id, box }) => (box
      ? `  ${id.padEnd(14)} x ${String(box.left).padStart(7)} → ${String(box.right).padStart(7)}`
        + `   y ${String(box.top).padStart(7)} → ${String(box.bottom).padStart(7)}`
      : `  ${id.padEnd(14)} MISSING`))
    .join('\n');
}

/** Idempotent: the trigger is a toggle, so tapping an open picker closes it. */
async function openPicker(page) {
  const trigger = page.getByTestId('settings-section-picker');
  if (await trigger.getAttribute('aria-expanded') === 'true') return;
  await trigger.tap();
  await page.getByTestId('settings-section-picker-list').waitFor({ state: 'visible', timeout: 15_000 });
  // The list is positioned from a measured trigger rect, one frame after open.
  await page.waitForTimeout(150);
}

// ------------------------------------------------------------- assertions ---

/** Nothing about the dialog may slide sideways at the phone width. */
function assertNoSidewaysScroll(measurement, label) {
  assert.equal(
    measurement.documentScrollWidth,
    PHONE_VIEWPORT.width,
    `${label}: the page scrolls sideways (documentElement.scrollWidth ${measurement.documentScrollWidth})`,
  );
}

/**
 * The dialog body is not what #264 is about and must come out unchanged: the
 * full dialog width at the phone step, and nothing of its own sliding sideways.
 */
function assertBodyIsIntact(measurement, label) {
  const { contentBox } = measurement;
  assert.ok(contentBox, `${label}: the dialog body was not found`);
  assert.ok(
    Math.abs(contentBox.width - measurement.modalClientWidth) <= 1,
    `${label}: the body is ${contentBox.width}px inside a dialog`
      + ` ${measurement.modalClientWidth}px wide within its border`,
  );

  // Asserted at every font scale, including the extremes. It used to be a NOTE there: the
  // body carried a 49px overflow at scale 1.375 that this ticket neither caused nor owned,
  // and recording it kept the signal alive without failing #264 for someone else's defect.
  // #268 owned it and fixed it (the shortcut rows now wrap), so the NOTE is an assertion.
  const overflow = measurement.contentScroll.scrollWidth - measurement.contentScroll.clientWidth;
  const culprits = measurement.contentOverflowers
    .map((item) => `${item.owner ?? item.tag} → "${item.text}" ends at ${item.right}`)
    .join('; ');
  assert.ok(
    overflow <= 1,
    `${label}: the body slides sideways by ${overflow}px (scrollWidth`
      + ` ${measurement.contentScroll.scrollWidth}, clientWidth`
      + ` ${measurement.contentScroll.clientWidth}) — ${culprits}`,
  );
}

/** The nav may not take the screen the body needs. */
function assertNavBandStaysCheap(measurement, label) {
  const { asideBox, headerBox, contentBox, modalBox } = measurement;
  const navShare = asideBox.height / modalBox.height;
  results.push(
    `${label}: dialog ${modalBox.height}px = nav ${asideBox.height} (${Math.round(navShare * 100)}%)`
    + ` + title ${headerBox?.height} + body ${contentBox.height}`,
  );
  assert.ok(
    navShare <= MAX_NAV_SHARE,
    `${label}: the nav takes ${asideBox.height}px of ${modalBox.height}px`
      + ` (${Math.round(navShare * 100)}%, ceiling ${Math.round(MAX_NAV_SHARE * 100)}%)`,
  );
}

/**
 * The defect itself, stated without naming the control that answers it: whatever
 * the nav is at this width, it may not be showing some pages and hiding the rest
 * off-screen behind a scroll nothing advertises.
 *
 * A nav that renders no page controls until it is opened — the picker — passes
 * this vacuously and is held to `assertPickerIsAdvertised` and
 * `assertOpenListShowsEveryPage` instead. A strip has all seven in the DOM at
 * once, and is caught here.
 */
function assertNothingIsHiddenSideways(measurement, label) {
  const offscreen = measurement.tabs.filter(({ box }) => (
    box && (box.left < 0 || box.right > measurement.innerWidth)
  ));
  assert.equal(
    offscreen.length,
    0,
    `${label}: ${offscreen.length} of ${measurement.tabs.length} pages sit outside`
      + ` 0→${measurement.innerWidth}, reachable only by scrubbing\n${describeTabs(measurement)}`,
  );
  for (const scroller of measurement.stripScrollers) {
    assert.ok(
      scroller.scrollWidth <= scroller.clientWidth + 1,
      `${label}: the nav scroller ${scroller.testId ?? '(unnamed)'} holds ${scroller.scrollWidth}px`
        + ` in a ${scroller.clientWidth}px box`,
    );
  }
}

/**
 * The picker in its closed state: on screen, hittable, naming the page you are
 * on, and announcing that it opens something. And the strip is gone — a strip
 * still present would still be hiding five pages behind a blind scrub.
 */
function assertPickerIsAdvertised(measurement, label, expectedPage) {
  const { triggerBox } = measurement;
  assert.ok(triggerBox, `${label}: there is no section picker`);
  assert.equal(measurement.hasStrip, false, `${label}: the horizontal strip is still rendered`);
  assert.ok(
    triggerBox.left >= 0 && triggerBox.right <= measurement.innerWidth,
    `${label}: the picker spans ${triggerBox.left}→${triggerBox.right}, outside 0→${measurement.innerWidth}`,
  );
  assert.ok(
    triggerBox.top >= 0 && triggerBox.bottom <= measurement.innerHeight,
    `${label}: the picker spans ${triggerBox.top}→${triggerBox.bottom} vertically,`
      + ` outside 0→${measurement.innerHeight}`,
  );
  assert.ok(
    triggerBox.height >= MIN_TOUCH_TARGET,
    `${label}: the picker is ${triggerBox.height}px tall, under the ${MIN_TOUCH_TARGET}px a finger needs`,
  );
  assert.equal(measurement.triggerPopup, 'menu', `${label}: the picker does not announce a menu`);
  assert.equal(measurement.triggerExpanded, 'false', `${label}: the closed picker reports itself open`);
  assert.equal(
    measurement.triggerChevronTurn,
    'none/none',
    `${label}: the closed picker's chevron is turned (${measurement.triggerChevronTurn})`
      + ' — it points the wrong way, and the chevron is the whole affordance',
  );
  assert.match(
    measurement.triggerText,
    new RegExp(expectedPage),
    `${label}: the picker says "${measurement.triggerText}" instead of naming ${expectedPage}`,
  );
  results.push(`${label}: picker ${triggerBox.width}x${triggerBox.height} reading "${measurement.triggerText}"`);
}

/**
 * The open list: all seven pages wholly inside the viewport, each one a finger's
 * worth, and the list itself hiding nothing in either axis. Those together are
 * what "no gesture the UI does not advertise" means — the one gesture, the tap
 * on the picker, is advertised by the picker.
 */
function assertOpenListShowsEveryPage(measurement, label) {
  assert.equal(measurement.triggerExpanded, 'true', `${label}: the open picker reports itself closed`);
  assert.ok(measurement.listBox, `${label}: the list did not render`);
  assert.notEqual(
    measurement.triggerChevronTurn,
    'none/none',
    `${label}: the open picker's chevron did not turn`,
  );

  for (const { id, box } of measurement.tabs) {
    assert.ok(box, `${label}: no row for ${id}`);
    assert.ok(
      box.left >= 0 && box.right <= measurement.innerWidth,
      `${label}: the ${id} row spans ${box.left}→${box.right}, outside 0→${measurement.innerWidth}\n`
        + describeTabs(measurement),
    );
    assert.ok(
      box.top >= 0 && box.bottom <= measurement.innerHeight,
      `${label}: the ${id} row spans ${box.top}→${box.bottom} vertically,`
        + ` outside 0→${measurement.innerHeight}\n${describeTabs(measurement)}`,
    );
    assert.ok(
      box.height >= MIN_TOUCH_TARGET,
      `${label}: the ${id} row is ${box.height}px tall, under the ${MIN_TOUCH_TARGET}px a finger needs`,
    );
    assert.ok(
      box.width >= MIN_TOUCH_TARGET,
      `${label}: the ${id} row is ${box.width}px wide, under the ${MIN_TOUCH_TARGET}px a finger needs`,
    );
  }

  assert.ok(
    measurement.listScroll.scrollHeight <= measurement.listScroll.clientHeight + 1,
    `${label}: the list hides ${measurement.listScroll.scrollHeight - measurement.listScroll.clientHeight}px`
      + ` below its own fold\n${describeTabs(measurement)}`,
  );
  assert.ok(
    measurement.listScroll.scrollWidth <= measurement.listScroll.clientWidth + 1,
    `${label}: the list hides ${measurement.listScroll.scrollWidth - measurement.listScroll.clientWidth}px sideways`,
  );
  results.push(`${label}: all ${measurement.tabs.length} rows inside 0→${measurement.innerHeight}, list hides nothing`);
}

/**
 * Reaching a page means opening the picker and tapping its row. Tapped, not
 * clicked: a phone has no pointer, and `tap` will not invent the scroll a
 * programmatic one would.
 */
async function assertEveryPageOpens(page, label) {
  for (const section of SECTIONS) {
    await openPicker(page);
    await page.getByTestId(`settings-nav-${section.id}`).tap();
    await page.getByTestId(section.content).waitFor({ state: 'visible', timeout: 20_000 });
  }
  results.push(`${label}: all ${SECTIONS.length} pages opened by tapping their row`);
}

// ---------------------------------------------------------------- phases ---

/**
 * The height budget that chose the presentation: two columns of seven tabs is
 * four rows, and four rows do not fit the dialog the phone actually has.
 *
 * Read what this does and does not catch. `WRAPPED_NAV_HEIGHT` is a *recorded*
 * number — the wrapped layout was built and measured at 333px on this build (see
 * the commit), not re-measured here, because the wrapped CSS is not in the tree
 * to measure. So this phase fires when the **dialog grows** enough to afford
 * 333px of nav, and it does *not* fire if wrapping itself gets cheaper — shorter
 * labels or a smaller row would lower the 333 and this phase would never know.
 * It is a floor under the decision, not a full re-derivation of it.
 */
async function phase0() {
  const { context, page } = await openSettingsPage({
    viewport: 'phone',
    fontScale: 1,
  });
  try {
    const measurement = await measureDialog(page);
    const { modalBox, asideBox, headerBox, contentBox, triggerBox } = measurement;
    const oneRow = asideBox.height;
    const wrappedShare = WRAPPED_NAV_HEIGHT / modalBox.height;
    const bodyIfWrapped = modalBox.height - WRAPPED_NAV_HEIGHT - headerBox.height;
    results.push(
      `phase0: dialog ${modalBox.height}px at the device height —`
      + ` title ${headerBox.height}, picker band ${oneRow} (trigger ${triggerBox.height}),`
      + ` body ${contentBox.height}. The recorded ${WRAPPED_NAV_HEIGHT}px wrapped strip would be`
      + ` ${Math.round(wrappedShare * 100)}% of the dialog and leave the body`
      + ` ${Math.round(bodyIfWrapped)}px.`,
    );
    assert.ok(
      wrappedShare > MAX_NAV_SHARE,
      'phase0: the dialog has grown enough that a wrapped strip fits the nav budget —'
        + ` re-open the presentation choice. ${WRAPPED_NAV_HEIGHT}px is now`
        + ` ${Math.round(wrappedShare * 100)}% of a ${modalBox.height}px dialog`,
    );
  } finally {
    await context.close();
  }
}

async function phase1() {
  const { context, page } = await openSettingsPage({ viewport: 'phone', fontScale: 1 });
  try {
    const closed = await measureDialog(page);
    results.push(`phone/default: root font ${closed.rootFontSize}px, dpr ${closed.devicePixelRatio}`);
    assertPickerIsAdvertised(closed, 'phone/default', 'General');
    assertNoSidewaysScroll(closed, 'phone/default');
    assertBodyIsIntact(closed, 'phone/default');
    assertNavBandStaysCheap(closed, 'phone/default');

    await openPicker(page);
    const open = await measureDialog(page);
    results.push(describeTabs(open));
    assertOpenListShowsEveryPage(open, 'phone/default');
    assertNoSidewaysScroll(open, 'phone/default open');
    await page.screenshot({ path: path.join(artifactDir, 'phone-settings-picker-open.png') });

    // Getting out of the list must not throw the user out of Settings. The panel
    // closes the whole dialog on Escape from a window listener, so an open list
    // has to take that key first.
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-section-picker-list').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByTestId('settings-modal').waitFor({ state: 'visible', timeout: 5_000 });
    results.push('phone/default: Escape closed the list and left the dialog open');

    // The same by tapping away from it, which is the gesture a thumb has.
    await openPicker(page);
    await page.getByTestId('settings-content').tap();
    await page.getByTestId('settings-section-picker-list').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.getByTestId('settings-modal').waitFor({ state: 'visible', timeout: 5_000 });
    results.push('phone/default: a tap outside closed the list and left the dialog open');

    await assertEveryPageOpens(page, 'phone/default');
    // Left on the page a phone user came here for.
    await openPicker(page);
    await page.getByTestId('settings-nav-remote-access').tap();
    await page.getByTestId('settings-section-remote-access').waitFor({ state: 'visible' });
    // The chevron turns back through a 150ms transition, and a computed style
    // read mid-transition reports the frame it is on rather than the resting
    // state this asserts.
    await page.waitForTimeout(400);
    const onRemote = await measureDialog(page);
    assertPickerIsAdvertised(onRemote, 'phone/default on remote-access', 'Remote access');
    await page.screenshot({ path: path.join(artifactDir, 'phone-settings-remote-access.png') });
  } finally {
    await context.close();
  }
}

async function phase2() {
  for (const scale of [SMALLEST_FONT_SCALE, LARGEST_FONT_SCALE]) {
    const label = `phone/scale-${scale}`;
    const { context, page } = await openSettingsPage({ viewport: 'phone', fontScale: scale });
    try {
      const closed = await measureDialog(page);
      assert.ok(
        Math.abs(closed.rootFontSize - 16 * scale) <= 0.5,
        `${label}: the root font is ${closed.rootFontSize}px, not ${16 * scale}px — the scale never applied`,
      );
      results.push(`${label}: root font ${closed.rootFontSize}px`);
      assertPickerIsAdvertised(closed, label, 'General');
      assertNoSidewaysScroll(closed, label);
      assertBodyIsIntact(closed, label);
      assertNavBandStaysCheap(closed, label);

      await openPicker(page);
      const open = await measureDialog(page);
      results.push(describeTabs(open));
      assertOpenListShowsEveryPage(open, label);
      assertNoSidewaysScroll(open, `${label} open`);
      await page.screenshot({ path: path.join(artifactDir, `phone-settings-picker-${scale}.png`) });

      await assertEveryPageOpens(page, label);
    } finally {
      await context.close();
    }
  }
}

/**
 * Above the Phone viewport step nothing moves: the same seven tabs in the same
 * order, still stacked in one column down the sidebar, and no picker — which is
 * what "same tabs, same order, same single row" means for a nav that is a
 * column at desktop width.
 */
async function phase3() {
  const { context, page } = await openSettingsPage({ viewport: 'desktop', fontScale: 1 });
  try {
    const measurement = await measureDialog(page);
    assert.equal(measurement.hasStrip, true, 'desktop: the tab strip is gone');
    assert.equal(measurement.triggerBox, null, 'desktop: the phone picker leaked above the step');

    const boxes = measurement.tabs.map(({ id, box }) => {
      assert.ok(box, `desktop: no nav button for ${id}`);
      return { id, box };
    });
    const firstLeft = boxes[0].box.left;
    for (const { id, box } of boxes) {
      assert.equal(box.left, firstLeft, `desktop: the ${id} tab left the single column`);
    }
    for (let index = 1; index < boxes.length; index += 1) {
      assert.ok(
        boxes[index].box.top > boxes[index - 1].box.top,
        `desktop: ${boxes[index].id} is not below ${boxes[index - 1].id} — the order changed`,
      );
    }
    for (const scroller of measurement.stripScrollers) {
      assert.ok(
        scroller.scrollWidth <= scroller.clientWidth + 1,
        `desktop: the nav scroller ${scroller.testId ?? '(unnamed)'} now scrolls sideways`,
      );
    }

    for (const section of SECTIONS) {
      await page.getByTestId(`settings-nav-${section.id}`).click();
      await page.getByTestId(section.content).waitFor({ state: 'visible', timeout: 20_000 });
    }

    results.push(
      `desktop: ${boxes.length} tabs in one column at x=${firstLeft},`
      + ` ${boxes[0].box.width}px wide, every page opened`,
    );
    await page.screenshot({ path: path.join(artifactDir, 'desktop-settings-nav.png') });
  } finally {
    await context.close();
  }
}

/**
 * Phases 1 and 2 again with the address bar scrolled away. The phone has two
 * real content heights, not one, and this file used to take the taller of them
 * as its default (#265). Now the phases above run at the height the user starts
 * at and this one runs at the height they get once the page scrolls, so the
 * verdicts that matter — the list fitting the viewport, the body keeping its
 * share — hold on both sides of the transition rather than on one.
 */
async function phase4() {
  for (const scale of [1, LARGEST_FONT_SCALE]) {
    const label = `phone-${PHONE_VIEWPORT_ADDRESS_BAR_HIDDEN.height}/scale-${scale}`;
    const { context, page } = await openSettingsPage({
      viewport: 'phone-address-bar-hidden',
      fontScale: scale,
    });
    try {
      const closed = await measureDialog(page);
      assert.equal(
        closed.innerHeight,
        PHONE_VIEWPORT_ADDRESS_BAR_HIDDEN.height,
        `${label}: the page is not at the address-bar-hidden height`,
      );
      results.push(`${label}: root font ${closed.rootFontSize}px, page ${closed.innerHeight}px tall`);
      assertPickerIsAdvertised(closed, label, 'General');
      assertNoSidewaysScroll(closed, label);
      assertBodyIsIntact(closed, label);
      assertNavBandStaysCheap(closed, label);

      await openPicker(page);
      const open = await measureDialog(page);
      results.push(describeTabs(open));
      assertOpenListShowsEveryPage(open, label);
      await page.screenshot({
        path: path.join(
          artifactDir,
          `phone-${PHONE_VIEWPORT_ADDRESS_BAR_HIDDEN.height}-settings-picker-${scale}.png`,
        ),
      });

      await assertEveryPageOpens(page, label);
    } finally {
      await context.close();
    }
  }
}

/**
 * The band between the two controls, 640-767px (#266).
 *
 * The picker hung off the Phone viewport step and the column hangs off the
 * dialog's `md:`, so these widths had neither and kept the strip: measured
 * headful at 700x880 before the fix, 1040px of tabs in a 658px box with
 * remote-access, development and git wholly outside the viewport — the same
 * blind scrub #264 removed from the phone.
 *
 * The band belongs to the picker rather than to an earlier column because of the
 * width, not the height: the picker leaves the body the dialog's full 658px at
 * 700px wide for a 111.5px band (14%), where `md:w-64` is 16rem — 256px at the
 * default scale, 352px at the largest — and would leave the body 402px, or 231px
 * at 640px with the largest scale, narrower than the body a 360px phone gets.
 */
async function phase5() {
  const label = `band-${BAND_VIEWPORT.width}`;
  const { context, page } = await openSettingsPage({ viewport: BAND_VIEWPORT, fontScale: 1 });
  try {
    const closed = await measureDialog(page);
    results.push(`${label}: dialog ${closed.modalClientWidth}px wide, page ${closed.innerWidth}px`);
    assertNothingIsHiddenSideways(closed, label);
    assertPickerIsAdvertised(closed, label, 'General');
    assertNavBandStaysCheap(closed, label);

    await openPicker(page);
    const open = await measureDialog(page);
    assertOpenListShowsEveryPage(open, label);
    await page.screenshot({ path: path.join(artifactDir, `settings-picker-${BAND_VIEWPORT.width}.png`) });

    await assertEveryPageOpens(page, label);
  } finally {
    await context.close();
  }

  // The far edge, which is what "no width falls between two controls" means: one
  // step up the column has to be the one that answers.
  const edge = await openSettingsPage({
    viewport: { width: SIDEBAR_STEP_WIDTH, height: BAND_VIEWPORT.height },
    fontScale: 1,
  });
  try {
    const measurement = await measureDialog(edge.page);
    assert.equal(measurement.triggerBox, null, `${SIDEBAR_STEP_WIDTH}px: the picker outlived the band`);
    assert.equal(measurement.hasStrip, true, `${SIDEBAR_STEP_WIDTH}px: neither control is rendered`);
    const lefts = measurement.tabs.map(({ id, box }) => {
      assert.ok(box, `${SIDEBAR_STEP_WIDTH}px: no nav button for ${id}`);
      return box.left;
    });
    assert.ok(
      lefts.every((left) => left === lefts[0]),
      `${SIDEBAR_STEP_WIDTH}px: the tabs are not the sidebar column — the strip is back`,
    );
    results.push(`${SIDEBAR_STEP_WIDTH}px: the sidebar column has arrived, no picker`);
  } finally {
    await edge.context.close();
  }
}

// -------------------------------------------------------------------- run ---

const phases = [
  ['0', phase0],
  ['1', phase1],
  ['2', phase2],
  ['3', phase3],
  ['4', phase4],
  ['5', phase5],
];

try {
  await fs.mkdir(artifactDir, { recursive: true });
  await startServer();
  browser = await chromium.launch({ headless });
  for (const [name, phase] of phases) {
    if (selectedPhases && !selectedPhases.has(name)) continue;
    await phase();
    console.log(`ok phase ${name}`);
  }
  console.log(results.join('\n'));
  console.log(`\nartifacts: ${artifactDir}`);
} catch (error) {
  console.error(results.join('\n'));
  console.error(`\nartifacts: ${artifactDir}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await stopServer();
}
