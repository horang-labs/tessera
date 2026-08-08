// Ticket #262 — two phone-width layout defects, at the viewport they were measured at.
//
// (b) The quick-create sheet was `w-[17rem]`, and `rem` resolves against a root font the user
//     scales: at the smallest of FONT_SCALE_OPTIONS it came out 221px on a 360px screen and
//     clipped its own labels. The run uses that scale throughout — the default has enough
//     slack to pass unfixed.
// (c) With two PTY tabs open both input bars were laid out at the same coordinates. The
//     inactive one's `visibility: hidden` was already correct, so it is asserted to still be.
//
// The ticket's third defect, an overlapping Git panel header, is absent: every column right of
// the `GIT` label in its own screenshot is pure background. See the issue comment.
// Not covered: the bytes the bar puts on the wire (mobile-terminal-input-bar), creating a
// session through the sheet (#244), and anything needing a real soft keyboard.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const run = promisify(execFile);
const DESKTOP_VIEWPORT = { width: 1000, height: 900 };
/** The smallest of FONT_SCALE_OPTIONS — where a `rem` width is at its narrowest. */
const FONT_SCALE = 0.8125;
/** `w-[17rem]` at that scale. Desktop must still get the `rem` width, not the phone's. */
const DESKTOP_SHEET_WIDTH = Math.round(17 * 16 * FONT_SCALE);
/**
 * The floor for "took the width the screen has". The fixed sheet is `calc(100vw-1.5rem)`,
 * which is 340.5px at this scale, and the clamp keeps 12px each side; 48 is that inset with
 * slack, since the `rem` part of it moves with the scale. It sits well above both unfixed
 * widths (221px here, 272px at the default scale), which is what it has to discriminate.
 */
const PHONE_SHEET_MIN_WIDTH = PHONE_VIEWPORT.width - 48;
const SHEET_SELECTOR = '[data-testid^="collection-quick-create-"]:not([data-testid*="toggle"])';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-262-'));
const projectDir = path.join(await fs.mkdtemp(path.join(tempRoot, 'tessera-262-fixture-')), 'repo');
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';
let appSecret;
let collectionId;
let browser;

await fs.mkdir(projectDir, { recursive: true });
await run('git', ['init', '-b', 'main', projectDir]);

const server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
  cwd: repoRoot,
  detached: true,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'development',
    TESSERA_DATA_DIR: dataDir,
    TESSERA_ELECTRON_RUNTIME: '1',
    // Without this the browser's WebSocket is refused, and the sidebar never receives the
    // collection list it draws the + control from.
    TESSERA_ELECTRON_AUTH_BYPASS: '1',
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
}

try {
  appSecret = await waitForServer(server);
  // The font scale is a server setting; seeding localStorage is overwritten by the settings
  // the client then receives, which is how a first run of this file measured 272px.
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl', fontSize: FONT_SCALE }),
  });
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: projectDir }) });
  const collection = await api('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectDir, label: '262', color: '#7c3aed' }),
  });
  collectionId = collection.json?.collection?.id;
  assert.ok(collectionId, `no collection: ${collection.text}`);

  browser = await launchPhoneBrowser();
  await testTheSheetTakesTheWidthAPhoneOffers();
  await testTheSheetKeepsItsRemWidthAtDesktopWidth();
  await testOnlyTheActiveTabsInputBarIsLaidOut();
  console.log('phone sheet width and inactive input bar: all phases passed');
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- isolated server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (server.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } }
  await waitForExit(server, 5_000);
  await fs.rm(dataDir, { recursive: true, force: true });
}

// --------------------------------------------------------------------- (b) ---

async function testTheSheetTakesTheWidthAPhoneOffers() {
  const { context, page } = await openPage(createPhoneContext);
  try {
    const box = await (await openQuickCreateSheet(page)).boundingBox();
    assert.ok(box, 'the sheet should be measurable');
    assert.ok(
      box.width >= PHONE_SHEET_MIN_WIDTH,
      `the sheet took ${Math.round(box.width)}px of a ${PHONE_VIEWPORT.width}px screen`,
    );
    assert.ok(
      box.x >= 0 && box.x + box.width <= PHONE_VIEWPORT.width,
      `the wider sheet escaped the viewport: ${JSON.stringify(box)}`,
    );

    // Width on the container is not width in the content, so one truncated label stands for
    // the content. Deliberately not asserted: that `New Worktree` sits on one line. The AC
    // asks for it, but it was already on one line at 221px — measured — so an assertion on
    // it would pass with or without this fix and prove nothing. What wraps to three lines in
    // that card is the description under the heading, which is body text and is meant to.
    const truncated = await page.evaluate((selector) => (
      [...document.querySelectorAll(`${selector} *`)]
        .filter((el) => !el.children.length && el.textContent?.includes('·'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent.trim())
    ), SHEET_SELECTOR);
    assert.deepEqual(truncated, [], `execution-mode labels are still truncated: ${truncated}`);
  } finally {
    await context.close();
  }
}

async function testTheSheetKeepsItsRemWidthAtDesktopWidth() {
  const { context, page } = await openPage(
    (instance, options) => instance.newContext({ ...options, viewport: DESKTOP_VIEWPORT }),
  );
  try {
    const box = await (await openQuickCreateSheet(page)).boundingBox();
    assert.equal(
      Math.round(box?.width ?? 0),
      DESKTOP_SHEET_WIDTH,
      'the phone width must not reach a desktop window',
    );
  } finally {
    await context.close();
  }
}

// --------------------------------------------------------------------- (c) ---

async function testOnlyTheActiveTabsInputBarIsLaidOut() {
  const { context, page } = await openPage(createPhoneContext, {
    'tessera-tab-store': JSON.stringify(seedTerminalTabs()),
  });
  try {
    await openChat(page);
    // A tab outside lruTabIds gets no slot at all, so the second one has to be visited once
    // before there are two bars to compare.
    await activateTab(page, 1);
    await activateTab(page, 0);

    const bars = await page.evaluate(() => (
      [...document.querySelectorAll('[data-testid="terminal-input-bar-textarea"]')].map((el) => {
        const slot = el.closest('[data-testid="tab-panel-slot"]');
        const { x, y, width, height } = el.getBoundingClientRect();
        return {
          active: slot?.getAttribute('data-active') === 'true',
          ariaHidden: slot?.getAttribute('aria-hidden'),
          visibility: getComputedStyle(el).visibility,
          rect: [x, y, width, height].map(Math.round),
        };
      })
    ));
    assert.equal(bars.length, 2, 'both tabs should still be mounted');
    const active = bars.find((bar) => bar.active);
    const inactive = bars.find((bar) => !bar.active);
    assert.ok(active && inactive, 'exactly one bar should belong to the active tab');

    assert.notDeepEqual(
      inactive.rect,
      active.rect,
      `the inactive tab's bar is laid out on top of the active one at ${active.rect}`,
    );
    // The hiding was already right. Taking the layout cost away must not have replaced it.
    assert.equal(inactive.visibility, 'hidden', 'the inactive bar lost visibility: hidden');
    assert.equal(inactive.ariaHidden, 'true', 'the inactive tab lost aria-hidden');
  } finally {
    await context.close();
  }
}

// ----------------------------------------------------------------- harness ---

function seedTerminalTabs() {
  const tabs = ['Term A', 'Term B'].map((title, index) => {
    const panelId = `e2e-panel-${index}`;
    return {
      id: `e2e-tab-${index}`,
      projectDir: null,
      title,
      isPreview: false,
      snapshot: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: null, terminalId: `e2e-term-${index}` } },
        activePanelId: panelId,
      },
    };
  });
  const activeTabId = tabs[0].id;
  return { version: 3, currentProjectDir: null, activeTabId, projects: {}, global: { tabs, activeTabId } };
}

async function openPage(makeContext, seed) {
  const context = await makeContext(browser, { extraHTTPHeaders: { 'x-tessera-app-secret': appSecret } });
  if (seed) {
    await context.addInitScript((entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    }, Object.entries(seed));
  }
  const page = await context.newPage();
  page.on('pageerror', (error) => { serverOutput += `[renderer] ${error.message}\n`; });
  return { context, page };
}

async function openChat(page) {
  // 'load' rather than 'domcontentloaded': every box here is a styled box, and an unstyled
  // element measures as its text.
  await page.goto(`${appOrigin}/chat`, { waitUntil: 'load', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 60_000 });
  // Every width below is a `rem` width, so nothing may be measured until the scale the
  // settings carry has actually reached the document.
  await page.waitForFunction(
    (scale) => getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim() === String(scale),
    FONT_SCALE,
    { timeout: 30_000 },
  );
  await page.addStyleTag({ content: '[data-agentation-root] { display: none !important; }' });
}

async function activateTab(page, index) {
  await page.getByTestId('tab-list-trigger').tap();
  await page.getByTestId('tab-list-popover').waitFor({ timeout: 10_000 });
  await page.getByTestId('tab-list-item').nth(index).tap();
  await page.waitForTimeout(1_500);
}

async function openQuickCreateSheet(page) {
  await openChat(page);
  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();
  // The expand control exists only while the sidebar is collapsed, which the shell forces
  // below 1024px.
  await page.waitForTimeout(500);
  const expand = page.locator('[data-testid="tab-bar-sidebar-toggle"]');
  if (await expand.isVisible().catch(() => false)) await expand.click();

  const toggle = page.locator(`[data-testid="collection-quick-create-toggle-${collectionId}"]`);
  await toggle.waitFor({ state: 'visible', timeout: 30_000 });
  await toggle.click();
  const sheet = page.locator(SHEET_SELECTOR).first();
  await sheet.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  return sheet;
}

async function api(pathname, init) {
  const response = await fetch(`${appOrigin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      // Mutating routes check the origin; fetch does not set one the way a browser would.
      origin: appOrigin,
    },
  });
  const text = await response.text();
  assert.ok(response.ok, `${pathname} failed: ${text}`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not every route answers JSON */ }
  return { json, text };
}

async function waitForServer(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${serverOutput}`);
    try {
      const secret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(`${appOrigin}/api/settings`, { headers: { 'x-tessera-app-secret': secret } });
      if (response.ok) return secret;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never started:\n${serverOutput}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  if (await Promise.race([exited, timedOut]) !== 'timeout') return;
  if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  await exited;
}

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return selected;
}
