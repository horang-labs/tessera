// Ticket #247 — at Phone viewport one control opens the tab list, in place of the strip.
//
// The strip cannot be salvaged at 360px by arithmetic: the chrome beside it takes 112px of
// the 316px left over from the 44px project strip, and the scroll gradients overlay another
// 64px, so about 140px remains for a tab that costs ~68px of fixture before its title. The
// assertions below are therefore about reachability — every open tab has a row, and picking
// one activates it — not about how well the strip scrolls.
//
// What this file cannot settle: whether a real Android tap dismisses the list before it can
// be read. That is the new-session sheet's symptom (#244), and Playwright reproduces neither
// Android Chrome's sticky hover nor its synthetic-event sequence. The "still open" assertion
// here proves the popover does not close *itself* after a synthetic tap; a phone still has to
// be held.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

// Distinct, ordinary session titles. Five is more than the strip could ever show at this
// width, and long enough that a truncated one is still told apart from its neighbours.
const TAB_TITLES = [
  'Phone viewport foundation',
  'Terminal input bar',
  'Tab list control',
  'Archive table width',
  'Send button overflow',
];
const ACTIVE_INDEX = 0;
/** The tab picked from the list — not the one already active, or selecting proves nothing. */
const TARGET_INDEX = 3;
/** The tab closed from the list — again not the active one, so closing is all that is tested. */
const CLOSE_INDEX = 2;

/** Phases can be narrowed with TESSERA_E2E_PHASES=4 while iterating, as the sheet suite does. */
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function shouldRun(phase) {
  return selectedPhases.length === 0 || selectedPhases.includes(String(phase));
}

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-mobile-tab-list-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

// The server runs from the repository itself, not from a copy: Tailwind only generates the
// utility layer for the source tree it is pointed at, and a copied app root serves the page
// unstyled — where every box measured here would be a content box instead of a laid-out one.
const server = spawn(
  process.execPath,
  ['./node_modules/.bin/tsx', 'server.ts'],
  {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

server.stdout.on('data', (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});
server.stderr.on('data', (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});

let browser;
let appSecret;
try {
  appSecret = await waitForServer(`${appOrigin}/api/settings`, server);

  browser = await chromium.launch({ headless: true });
  if (shouldRun(1)) await testPhoneReplacesTheStripWithOneControl(browser, appOrigin);
  if (shouldRun(2)) await testTheListHoldsEveryOpenTab(browser, appOrigin);
  if (shouldRun(3)) await testChoosingATabActivatesIt(browser, appOrigin);
  if (shouldRun(4)) await testATabCanBeClosedFromTheList(browser, appOrigin);
  if (shouldRun(5)) await testDesktopStripIsUnchanged(browser, appOrigin);
  console.log('mobile-tab-list: all phases passed');
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- isolated server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // The isolated server may already have exited after a startup failure.
    }
  }
  await waitForExit(server, 5_000);
  await fs.rm(dataDir, { recursive: true, force: true });
}

async function testPhoneReplacesTheStripWithOneControl(browserInstance, origin) {
  const { context, page } = await createSeededPage(browserInstance, createPhoneContext);

  try {
    await openChat(page, origin);

    const trigger = page.getByTestId('tab-list-trigger');
    await trigger.waitFor({ timeout: 15_000 });

    assert.equal(
      await page.getByTestId('tab-bar-items').count(),
      0,
      'the scrollable tab strip must not render at Phone viewport',
    );
    assert.equal(
      await page.getByTestId('tab-item').count(),
      0,
      'no tab from the strip may survive at Phone viewport',
    );

    const box = await trigger.boundingBox();
    assert.ok(box, 'the tab list control should be measurable');
    assert.ok(
      box.x >= -1 && box.x + box.width <= PHONE_VIEWPORT.width + 1,
      `the tab list control must sit inside the viewport (${JSON.stringify(box)})`,
    );
    assert.equal(
      (await trigger.innerText()).trim(),
      TAB_TITLES[ACTIVE_INDEX],
      'the control must name the tab that is currently active',
    );

    // Naming the tab in the DOM is not the criterion — being readable on the device is.
    // The strip's width was the whole defect, so the control has to inherit the ~204px the
    // ticket's arithmetic left beside the chrome, rather than share it with a spacer.
    const addBox = await page.getByTestId('tab-bar-add').boundingBox();
    assert.ok(addBox, 'the + button should be measurable');
    assert.ok(
      Math.abs(box.x + box.width - addBox.x) <= 1,
      'dead space between the tab name and the + button is width the name should have had'
        + ` (control ends at ${box.x + box.width}px, + starts at ${addBox.x}px)`,
    );

    const label = await trigger.evaluate((element) => {
      const span = element.querySelector('span');
      return span ? { clientWidth: span.clientWidth, scrollWidth: span.scrollWidth } : null;
    });
    assert.ok(label, 'the control should carry a label element');
    assert.ok(
      label.clientWidth >= 140,
      `the tab name got ${label.clientWidth}px, which cuts it to a few characters`,
    );
  } finally {
    await context.close();
  }
}

async function testTheListHoldsEveryOpenTab(browserInstance, origin) {
  const { context, page } = await createSeededPage(browserInstance, createPhoneContext);

  try {
    await openChat(page, origin);
    await page.getByTestId('tab-list-trigger').tap();

    const popover = page.getByTestId('tab-list-popover');
    await popover.waitFor({ timeout: 5_000 });

    const rows = page.getByTestId('tab-list-item');
    assert.equal(
      await rows.count(),
      TAB_TITLES.length,
      'every open tab must have a row — the list is the whole set, not a scrollable subset',
    );
    const rowTitles = (await rows.allInnerTexts()).map((text) => text.trim());
    assert.deepEqual(rowTitles, TAB_TITLES, 'the rows must name the open tabs, in tab order');

    for (const [index, title] of TAB_TITLES.entries()) {
      const rowBox = await rows.nth(index).boundingBox();
      assert.ok(rowBox, `row ${index} (${title}) should be measurable`);
      assert.ok(
        rowBox.x >= -1 && rowBox.x + rowBox.width <= PHONE_VIEWPORT.width + 1,
        `row ${index} (${title}) escaped the viewport horizontally: ${JSON.stringify(rowBox)}`,
      );
      assert.ok(
        rowBox.y >= -1 && rowBox.y + rowBox.height <= PHONE_VIEWPORT.height + 1,
        `row ${index} (${title}) was not reachable on screen: ${JSON.stringify(rowBox)}`,
      );
    }

    // The new-session sheet's defect was "opens, then closes on its own" (#244). This is the
    // same popover family, so the list is watched doing nothing for a while before it is
    // trusted. A real Android tap is still device-only.
    await page.waitForTimeout(1_000);
    assert.equal(
      await popover.isVisible(),
      true,
      'the list closed on its own after opening — the sheet symptom, in this family again',
    );

    // The other half of the same criterion: it must close when dismissed, or a phone is left
    // with a list it cannot put away without choosing a tab it did not want.
    await page.touchscreen.tap(180, PHONE_VIEWPORT.height - 80);
    await popover.waitFor({ state: 'detached', timeout: 5_000 });
  } finally {
    await context.close();
  }
}

async function testChoosingATabActivatesIt(browserInstance, origin) {
  const { context, page } = await createSeededPage(browserInstance, createPhoneContext);

  try {
    await openChat(page, origin);
    const trigger = page.getByTestId('tab-list-trigger');
    await trigger.tap();
    await page.getByTestId('tab-list-popover').waitFor({ timeout: 5_000 });

    await page.getByTestId('tab-list-item').nth(TARGET_INDEX).tap();

    await page.getByTestId('tab-list-popover').waitFor({ state: 'detached', timeout: 5_000 });
    await page.waitForFunction(
      (expected) => (
        document.querySelector('[data-testid="tab-list-trigger"]')?.textContent?.includes(expected)
          ?? false
      ),
      TAB_TITLES[TARGET_INDEX],
      { timeout: 5_000 },
    );

    // Reopening shows the choice took effect on the tab state, not only on the label.
    await trigger.tap();
    await page.getByTestId('tab-list-popover').waitFor({ timeout: 5_000 });
    const activeRow = page.locator('[data-testid="tab-list-item"][data-active="true"]');
    assert.equal(await activeRow.count(), 1, 'exactly one row must be marked active');
    assert.equal(
      (await activeRow.innerText()).trim(),
      TAB_TITLES[TARGET_INDEX],
      'the chosen tab must be the active one',
    );
  } finally {
    await context.close();
  }
}

/**
 * Closing a tab, which the strip carried on every tab item.
 *
 * The strip is gone at this width, and with it the only close affordance a phone had — the
 * context menu needs a right-click on a tab, Ctrl+W needs a keyboard, and the remaining
 * `closeTab` call sites are drag-and-drop paths. Without a row control, tabs accumulate for
 * the life of the session with no way back.
 */
async function testATabCanBeClosedFromTheList(browserInstance, origin) {
  const { context, page } = await createSeededPage(browserInstance, createPhoneContext);

  try {
    await openChat(page, origin);
    await page.getByTestId('tab-list-trigger').tap();
    const popover = page.getByTestId('tab-list-popover');
    await popover.waitFor({ timeout: 5_000 });

    const rows = page.getByTestId('tab-list-item');
    const closes = page.getByTestId('tab-list-item-close');
    assert.equal(
      await closes.count(),
      TAB_TITLES.length,
      'every row must carry its own close target',
    );

    // A mis-tap here closes someone's tab, so the close target is measured as a target: its
    // own box, comfortably sized, not overlapping the area that merely switches tabs.
    const selectBox = await rows.nth(CLOSE_INDEX).boundingBox();
    const closeBox = await closes.nth(CLOSE_INDEX).boundingBox();
    assert.ok(selectBox && closeBox, 'both targets in a row should be measurable');
    assert.ok(
      closeBox.width >= 40 && closeBox.height >= 40,
      `the close target is ${closeBox.width}x${closeBox.height}, too small to hit deliberately`,
    );
    assert.ok(
      closeBox.x >= selectBox.x + selectBox.width - 1,
      'the close target must not overlap the row area that switches tabs'
        + ` (switch ends at ${selectBox.x + selectBox.width}px, close starts at ${closeBox.x}px)`,
    );

    await closes.nth(CLOSE_INDEX).tap();

    const remaining = TAB_TITLES.filter((_, index) => index !== CLOSE_INDEX);
    await page.waitForFunction(
      (expected) => (
        document.querySelectorAll('[data-testid="tab-list-item"]').length === expected
      ),
      remaining.length,
      { timeout: 5_000 },
    );
    assert.deepEqual(
      (await rows.allInnerTexts()).map((text) => text.trim()),
      remaining,
      'the closed tab must be gone and the others left alone',
    );
    assert.equal(
      await popover.isVisible(),
      true,
      'closing one tab must not put the list away — closing two should not need two trips',
    );
  } finally {
    await context.close();
  }
}

// The overriding constraint for this wave: the desktop layout must not regress.
async function testDesktopStripIsUnchanged(browserInstance, origin) {
  const { context, page } = await createSeededPage(browserInstance, (instance, options) => (
    instance.newContext({ ...options, viewport: DESKTOP_VIEWPORT })
  ));

  try {
    await openChat(page, origin);
    await page.getByTestId('tab-bar-items').waitFor({ timeout: 15_000 });

    assert.equal(
      await page.getByTestId('tab-item').count(),
      TAB_TITLES.length,
      'the desktop strip must still render one item per open tab',
    );
    assert.equal(
      await page.getByTestId('tab-list-trigger').count(),
      0,
      'the phone control must not exist in a desktop tree',
    );
  } finally {
    await context.close();
  }
}

/**
 * A window with tabs already open.
 *
 * The tabs are seeded through the app's own persistence format rather than by driving the +
 * button, because `openNewTab` reuses an empty tab and would never produce five of them.
 */
function seedTabStore() {
  const tabs = TAB_TITLES.map((title, index) => {
    const panelId = `e2e-panel-${index}`;
    return {
      id: `e2e-tab-${index}`,
      projectDir: null,
      title,
      isPreview: false,
      snapshot: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: null } },
        activePanelId: panelId,
      },
    };
  });

  return {
    version: 3,
    currentProjectDir: null,
    activeTabId: tabs[ACTIVE_INDEX].id,
    projects: {},
    global: { tabs, activeTabId: tabs[ACTIVE_INDEX].id },
  };
}

async function createSeededPage(browserInstance, makeContext) {
  const context = await makeContext(browserInstance, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    ['tessera-tab-store', JSON.stringify(seedTabStore())],
  );
  const page = await context.newPage();
  return { context, page };
}

async function openChat(page, origin) {
  // 'load' rather than 'domcontentloaded': every box measured here is a styled box, and an
  // unstyled control measures as its content.
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
  await page.getByTestId('tab-bar').waitFor({ timeout: 30_000 });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  if (await Promise.race([exited, timedOut]) !== 'timeout') return;
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process exited between the timeout and the forced cleanup.
    }
  }
  await exited;
}

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const selectedPort = address.port;
  await new Promise((resolve, reject) => listener.close((error) => (
    error ? reject(error) : resolve()
  )));
  return selectedPort;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated Tessera server exited with code ${child.exitCode}`);
    }
    try {
      const secret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(url, {
        headers: { 'x-tessera-app-secret': secret },
      });
      if (response.ok) return secret;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for isolated Tessera server at ${url}`);
}
