/**
 * The 44px floor for the controls #259's measurement list missed (#270).
 *
 * QA round 2 drove the phone build by hand and measured what it touched: the
 * message action row 16px tall, the tab list #247 created at 28-33px, the GUI
 * composer's send at 26px beside the PTY composer's 44px, the tab bar's icons
 * at 29px, the Git panel's close at 23px and the project strip's entries at
 * 26px. Every box below is a `getBoundingClientRect()` on the control's own
 * element, taken the way QA took it.
 *
 *   1. Phone (360x776, touch, font scale 0.8125): every listed control clears
 *      44px on the axes it can. 0.8125 is the scale QA measured at and the
 *      worst case — a `rem`-sized box is 19% smaller there than its class name
 *      claims, which is the whole reason the floor is stated in px.
 *   2. Desktop (1280x900, no touch): the same controls measure what the unfixed
 *      build measured. The floor is `max-sm:`-guarded, and a pointer keeps the
 *      small chrome it has always had.
 *
 * Not settled here: whether a thumb misses a 16px target, and whether the
 * enlarged action row is the shape a phone wants. The ticket's acceptance
 * criteria carry both, because neither is a question a harness can answer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';
import { startPhoneAppServer } from './helpers/phone-app-server.mjs';

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
/** `PHONE_TOUCH_TARGET_PX` from `src/lib/ui/touch-target.ts`, restated: a
 *  `.mjs` run cannot import the TypeScript module that owns it. */
const MIN_TOUCH_TARGET = 44;
/** The scale QA measured at: a 13px root, where `h-11` is 35.75px. */
const SMALLEST_FONT_SCALE = 0.8125;

/**
 * Every control the ticket measured. `heightOnly` marks the ones that already
 * span their row, where forcing a minimum width would fight the layout that
 * gives them more. `desktop` is what the unfixed build measured at 1280x900 and
 * the 16px root — recorded rather than recomputed, so a rule that leaked past
 * the Phone step fails here instead of being explained away.
 */
const CONTROLS = [
  { selector: '[data-testid="message-actions"] button', label: 'a message action', heightOnly: true, desktop: { height: 20 } },
  { selector: '[data-testid="tab-bar-sidebar-toggle"]', label: 'expand the sidebar', desktop: { width: 36, height: 36 } },
  { selector: '[data-testid="tab-bar-add"]', label: 'new tab', desktop: { width: 36, height: 36 } },
  { selector: '[data-testid="tab-bar-git-toggle"]', label: 'the Git panel toggle', desktop: { width: 40, height: 36 } },
  // Height only, and not because it spans anything: the composer row is 280px
  // at 360px and cannot hold a third 44px-wide icon beside the 120px textarea
  // floor #251 set. The arithmetic is in `message-input.tsx`; #270's comment
  // records that the width is still owed.
  { selector: '[aria-label="Attach file"]', label: 'attach a file', heightOnly: true, desktop: { width: 32, height: 32 } },
  { selector: '[aria-label="Voice input"]', label: 'voice input', heightOnly: true, desktop: { width: 32, height: 32 } },
  { selector: '[data-testid="message-send-btn"]', label: 'send (GUI chat)', desktop: { width: 34, height: 34 } },
  // Every project entry: the strip's other buttons are named, an entry's test id
  // is `project-strip-` plus the project's absolute path.
  { selector: '[data-testid^="project-strip-/"]', label: 'a project strip entry', desktop: { width: 32, height: 32 } },
  // Phone only: the tab list replaces the tab strip below 640px (#247), and the
  // Git panel is opened here through a toggle the desktop phase leaves alone.
  { selector: '[data-testid="tab-list-trigger"]', label: 'the tab list trigger', heightOnly: true, phoneOnly: true },
  { selector: '[data-testid="tab-list-item"]', label: 'a tab list row', heightOnly: true, phoneOnly: true },
  { selector: '[data-testid="tab-list-item-close"]', label: 'a tab list close button', phoneOnly: true },
  { selector: '[data-testid="git-panel-close-btn"]', label: 'close the Git panel', phoneOnly: true },
];

const app = await startPhoneAppServer({ name: 'wave-touch-target' });
const results = [];
let browser = null;

const round = (value) => Math.round(value * 100) / 100;

const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-wave-touch-target-e2e');

/** A failing box is a claim about what a screen looks like; keep the screen. */
async function capture(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

/**
 * Opens the seeded conversation with the sidebar out of the way — at 360px it
 * takes the whole width, and a control behind it is not the one a user sees.
 *
 * 'load' rather than 'domcontentloaded': every box here is a styled box, and an
 * unstyled control measures as its content.
 */
async function openConversation(page) {
  await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 90_000 });

  const strip = page.locator(`[data-testid="project-strip-${app.projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();

  // The expand control only exists while the sidebar is collapsed, which the
  // shell forces below 1024px and remembers across contexts.
  const expand = page.locator('[data-testid="tab-bar-sidebar-toggle"]');
  await page.waitForTimeout(500);
  if (await expand.isVisible().catch(() => false)) await expand.click();

  const row = page.locator(`[data-testid="collection-chat-${app.sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();
  const collapse = page.getByTestId('sidebar-collapse-btn');
  if (await collapse.isVisible().catch(() => false)) await collapse.click();

  // The seeded turns arrive through the messages route, not with the shell.
  await page.locator('[data-testid="message-actions"]').first().waitFor({ state: 'visible', timeout: 30_000 });
  // Send is `scale-95` while there is nothing to send, and a transform is in the
  // box this measures. A submittable composer is the state a finger meets.
  await page.locator(`textarea[data-session-input="${app.sessionId}"]`).fill('measure me');
  await page.waitForTimeout(400);
}

/** Every match of every selector on screen, keyed by selector. */
function measure(page, selectors) {
  return page.evaluate((list) => Object.fromEntries(list.map((selector) => [
    selector,
    [...document.querySelectorAll(selector)].map((element) => {
      const box = element.getBoundingClientRect();
      return { width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100 };
    }),
  ])), selectors);
}

/** The tab list and the Git panel each sit behind a control of their own. */
async function measureBehindTheirToggles(page) {
  await page.getByTestId('tab-list-trigger').click();
  await page.getByTestId('tab-list-popover').waitFor({ state: 'visible', timeout: 15_000 });
  const list = await measure(page, ['[data-testid="tab-list-item"]', '[data-testid="tab-list-item-close"]']);
  await page.keyboard.press('Escape');

  await page.getByTestId('tab-bar-git-toggle').click();
  const close = page.getByTestId('git-panel-close-btn');
  await close.waitFor({ state: 'visible', timeout: 30_000 });
  const git = await measure(page, ['[data-testid="git-panel-close-btn"]']);
  await close.click();
  return { ...list, ...git };
}

/** Phase 1 — at 360x776 and the smallest font scale, every listed box is hittable. */
async function phase1() {
  await app.setFontScale(SMALLEST_FONT_SCALE);
  const context = await createPhoneContext(browser, { extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret } });
  try {
    const page = await app.preparePage(context);
    await openConversation(page);

    const root = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    assert.equal(root, '13px',
      `the font scale did not reach the page (root font ${root}); without it this phase proves nothing`);

    const boxes = { ...await measure(page, CONTROLS.map((c) => c.selector)), ...await measureBehindTheirToggles(page) };
    const tooSmall = [];
    for (const control of CONTROLS) {
      const found = boxes[control.selector] ?? [];
      assert.ok(found.length > 0, `${control.label} (${control.selector}) was never on screen, so nothing was measured`);
      for (const box of found) {
        const short = box.height + 0.5 < MIN_TOUCH_TARGET;
        const narrow = !control.heightOnly && box.width + 0.5 < MIN_TOUCH_TARGET;
        if (short || narrow) tooSmall.push(`${control.label} ${round(box.width)}x${round(box.height)}`);
      }
    }
    if (tooSmall.length > 0) await capture(page, 'phone-undersized-targets');
    assert.deepEqual(tooSmall, [],
      `these are under ${MIN_TOUCH_TARGET}px at 360x776 and font scale ${SMALLEST_FONT_SCALE},`
        + ` so a finger cannot land on them reliably (screenshot in ${artifactDir})`);

    results.push(`phase 1: ${CONTROLS.length} controls clear ${MIN_TOUCH_TARGET}px at font scale ${SMALLEST_FONT_SCALE}`);
  } finally {
    await context.close();
    await app.setFontScale(1);
  }
}

/** Phase 2 — a pointer keeps the small chrome it has always had. */
async function phase2() {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT, hasTouch: false, extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  try {
    const page = await app.preparePage(context);
    await openConversation(page);
    const onDesktop = CONTROLS.filter((control) => !control.phoneOnly);
    const boxes = await measure(page, onDesktop.map((c) => c.selector));

    const moved = [];
    for (const control of onDesktop) {
      const found = boxes[control.selector] ?? [];
      assert.ok(found.length > 0, `${control.label} was not on screen at ${DESKTOP_VIEWPORT.width}px`);
      for (const box of found) {
        const wrongHeight = Math.abs(box.height - control.desktop.height) > 0.5;
        const wrongWidth = control.desktop.width !== undefined && Math.abs(box.width - control.desktop.width) > 0.5;
        if (wrongHeight || wrongWidth) {
          moved.push(`${control.label} ${round(box.width)}x${round(box.height)}`
            + ` instead of ${control.desktop.width ?? 'any'}x${control.desktop.height}`);
        }
      }
    }
    assert.deepEqual(moved, [], 'the phone floor reached a pointer-driven window');
    results.push(`phase 2: ${onDesktop.length} controls unchanged at ${DESKTOP_VIEWPORT.width}px`);
  } finally {
    await context.close();
  }
}

try {
  await app.seedHistory([
    { v: 1, type: 'user_message', timestamp: '2026-08-08T01:00:00.000Z', content: 'hello', messageId: 'wave-u1' },
    { v: 1, type: 'assistant_message', timestamp: '2026-08-08T01:00:01.000Z', content: 'hi', messageId: 'wave-a1' },
  ]);
  browser = await launchPhoneBrowser();
  await phase1();
  await phase2();
} catch (error) {
  process.stderr.write(`\n--- isolated server output ---\n${app.logs()}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await app.stop();
}

for (const line of results) console.log(`ok — ${line}`);
