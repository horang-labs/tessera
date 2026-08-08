/**
 * End-to-end coverage for the phone's undersized touch targets (#259).
 *
 * QA measured the wave's own controls and found the chrome it had made
 * reachable was still not hittable: the session header's four icons at 15x15,
 * the PTY chat composer's send at 21x21 and its "open the terminal" at 11x11,
 * the collection `+` at 15x15, the sidebar's collapse at 23x23 and its filter
 * pair 16px tall. This file measures the same boxes the same way — a
 * `getBoundingClientRect()` on the control's own element, not on its icon.
 *
 *   1. Phone viewport (360x880, touch): every listed control's own hit box is
 *      at least 44x44 CSS px, the header's four icons are still four distinct
 *      non-overlapping targets, and the header row still fits 360px with its
 *      provider chip and session title on screen.
 *   2. Desktop width (1280x900, no touch): every one of those controls
 *      measures exactly what it measured before. A mouse hits 15x15 fine and
 *      nothing above the Phone viewport step may move.
 *
 * The server runs from the repository itself, not from a copied app root:
 * every assertion here is a measured box, and Tailwind only generates its
 * utility layer for the source tree it is pointed at. Against a copy the page
 * arrives with no utilities at all and every box measures as its content
 * (#252).
 *
 * What this file deliberately does not settle: whether an enlarged target is
 * comfortable under a real thumb, and whether two of them are now close enough
 * to mis-hit. Playwright taps the exact centre of whatever it is told to tap.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1 while iterating.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const run = promisify(execFile);

/** A pointer-driven window, which is what must not regress. */
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/**
 * The floor a finger needs. Stated in CSS px on purpose: the root font size
 * here is 13px, so anything expressed in `rem` lands ~19% under the number in
 * its class name — which is how #243 costed its keys at 44 and shipped 36.
 */
const MIN_TOUCH_TARGET = 44;

/**
 * What the header has to keep for the session title once the four targets are
 * placed. The row is the only place the enlargement takes width from, and the
 * title is the last thing in it that can lose any.
 */
const MIN_READABLE_TITLE = 32;

/**
 * Every control the ticket measured, with the surface it has to be reached
 * through. `heightOnly` marks the two that already span the sidebar's full
 * width, where only the height was ever the defect.
 */
const CONTROLS = [
  { testId: 'terminal-view-toggle', surface: 'session', label: 'View as chat' },
  { testId: 'message-search-open-button', surface: 'session', label: 'Search messages' },
  { testId: 'header-more-button', surface: 'session', label: 'More options' },
  { testId: 'panel-close-button', surface: 'session', label: 'Close session' },
  { testId: 'terminal-chat-composer-send', surface: 'composer', label: 'Send' },
  { testId: 'terminal-chat-back-to-terminal', surface: 'composer', label: 'Open the terminal' },
  {
    testId: 'collection-quick-create-toggle-__uncategorized',
    surface: 'sidebar',
    label: 'the + that #244 made visible',
  },
  { testId: 'sidebar-collapse-btn', surface: 'sidebar', label: 'Collapse the sidebar' },
  { testId: 'sidebar-all-filter', surface: 'sidebar', label: 'All sessions', heightOnly: true },
  { testId: 'sidebar-running-filter', surface: 'sidebar', label: 'Running sessions', heightOnly: true },
];

/** The four that share the session header row and must stay four targets. */
const HEADER_CONTROLS = CONTROLS.filter((control) => control.surface === 'session');

/**
 * The Terminal input bar #243 built. Not in this ticket's measurement list —
 * the issue recorded these as adequate at 47x36 and pointed at #262 for the
 * shortfall, but #262's (d) is the duplicated input bar and its boundary
 * excludes anything needing a decision, so nothing owned it. Sized here with
 * the same constant rather than left for a ticket that does not exist.
 *
 * The bar renders only at Phone viewport (`terminal-panel.tsx:361`), so there
 * is no desktop counterpart to measure.
 */
const INPUT_BAR_CONTROLS = [
  ...['escape', 'shift-tab', 'up', 'down', 'enter', 'ctrl-c'].map((namedKey) => ({
    testId: `terminal-input-bar-key-${namedKey}`,
    label: `named key ${namedKey}`,
  })),
  { testId: 'terminal-input-bar-send', label: 'Send to the terminal' },
  // Height only: it is `flex-1` and yields its width so the send button stays
  // on screen, which is #251's fix and must not be undone here.
  { testId: 'terminal-input-bar-textarea', label: 'the bar itself', heightOnly: true },
];

/**
 * The font scale QA measured at, and the only one at which the bar's `rem`
 * sizing falls short: 16px x 0.8125 = a 13px root, where `h-11` is 35.75px.
 * At the default scale the same class is a full 44px, so a phase that does not
 * set this cannot see the defect at all.
 */
const SMALLEST_FONT_SCALE = 0.8125;

/**
 * Headful by default, which is unusual for this repo and deliberate here.
 *
 * Every assertion in this file is a box a person is meant to be able to hit.
 * Headless Chromium rasterises differently, runs WebGL on SwiftShader and has
 * its device metrics injected rather than read from a display, and this wave
 * has already been burned by it twice: #256 chased a canvas-sizing defect that
 * may exist only under that emulation, and #260 was filed and closed
 * unreproducible after a headless observation that a file would not open. A
 * browser that never paints to a screen is not a witness to what a person sees.
 *
 * The rest of tests/ defaults headless, so this file is the exception and says
 * so here. It keeps the repo's `TESSERA_E2E_HEADED` variable rather than
 * inventing a second one — setting it to `1` still means headed, it is just
 * already the default. `TESSERA_E2E_HEADED=0` is the escape hatch for a machine
 * with no display, and a run that takes it is not evidence about layout.
 */
const headless = process.env.TESSERA_E2E_HEADED === '0';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-phone-touch-target-e2e');
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-touch-target-data-'));
const fixtureDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-touch-target-fixture-'));
const projectDir = path.join(fixtureDir, `touch-target-e2e-${path.basename(fixtureDir).slice(-6)}`);

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;

const serverOutput = [];
let server = null;
let browser = null;
let appSecret = null;
let sessionId = null;
const results = [];

function shouldRun(phase) {
  return selectedPhases.length === 0 || selectedPhases.includes(String(phase));
}

function logs() {
  return serverOutput.join('');
}

// --------------------------------------------------------------- fixtures ---

/**
 * One ordinary git repository. Nothing is committed to or branched — the
 * project only has to be something the app will accept, list, and open a
 * session on.
 */
async function prepareFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# touch target e2e\n', 'utf8');
}

// ----------------------------------------------------------------- server ---

/** A port nothing else is on, so parallel worktrees never meet on one. */
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
    'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID',
  ]) {
    delete env[key];
  }

  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      // Without this the browser's WebSocket is refused — `extraHTTPHeaders`
      // does not reach an upgrade request — and the sidebar never receives the
      // session list these controls are opened from.
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
      PORT: String(port),
      TESSERA_DEV_PORT: String(port),
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

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      });
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${logs()}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server = null;
}

// ------------------------------------------------------------------- http ---

async function api(pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      // Mutating routes check the origin; fetch does not set one for us the
      // way a browser would.
      origin,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

const BROWSER_USER_ID = 'e2e-browser-user';

/**
 * The account the browser's cookie will name. Written before the server
 * starts, because the request gate looks the token's subject up in this file
 * and an Electron-runtime server creates no account of its own.
 */
async function writeBrowserUser() {
  const now = new Date().toISOString();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'users.json'),
    JSON.stringify({
      users: [{
        id: BROWSER_USER_ID,
        username: 'e2e',
        passwordHash: 'unused',
        createdAt: now,
        lastLoginAt: now,
      }],
    }, null, 2),
    'utf8',
  );
}

async function mintBrowserToken() {
  const privateKey = await fs.readFile(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
  return jwt.sign(
    { sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
    privateKey,
    { algorithm: 'RS256', expiresIn: 3600 },
  );
}

async function registerProject() {
  // The fixture lives on the Linux filesystem, so the server has to be told to
  // treat paths that way before it will accept the folder.
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);

  const project = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });
  assert.equal(project.ok, true, `could not register ${projectDir}: ${project.text}`);
}

/**
 * One PTY session, because two of the six header/composer controls exist only
 * for one: the view toggle is offered only on a terminal session, and the
 * composer under test is the chat overlay that toggle opens. No message is
 * ever sent and no runtime is spawned by creating it.
 */
async function createSession() {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: projectDir,
      parentProjectId: projectDir,
      providerId: 'claude-code',
      executionMode: 'pty',
      title: 'touch target e2e',
      hasCustomTitle: true,
    }),
  });
  assert.equal(response.ok, true, `could not create a session: ${response.text}`);
  const id = response.json?.sessionId ?? response.json?.session?.id ?? response.json?.id;
  assert.ok(id, `the session response carried no id: ${response.text}`);
  return id;
}

// --------------------------------------------------------------------- ui ---

/** The shared wave context: 360x880 with touch enabled (spec #241). */
async function openPhonePage() {
  return preparePage(await createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  }));
}

async function openDesktopPage() {
  return preparePage(await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    hasTouch: false,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  }));
}

async function preparePage(context) {
  const token = await mintBrowserToken();
  await context.addCookies([
    { name: 'jwt', value: token, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));
  return { context, page };
}

/**
 * Opens the app on the fixture project with the sidebar expanded.
 *
 * 'load' rather than 'domcontentloaded': every box measured here is a styled
 * box, and an unstyled control measures as its content.
 */
async function openSidebar(page) {
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });

  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();

  // The expand control only exists while the sidebar is collapsed, which the
  // shell forces below 1024px and remembers across contexts.
  const expand = page.locator('[data-testid="tab-bar-sidebar-toggle"]');
  await page.waitForTimeout(500);
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }
  await page.getByTestId('sidebar-collapse-btn').waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Opens the fixture session and switches its terminal to the chat overlay, so
 * the header row and the PTY chat composer are both on screen.
 *
 * The sidebar is collapsed again first: at 360px it takes the whole width, and
 * a header behind it is not the header a user is looking at.
 */
async function openSessionSurfaces(page) {
  await openSession(page);
  await openTerminalChatView(page);
}

/**
 * Opens the fixture session in its terminal view, with the sidebar out of the
 * way — at 360px it takes the whole width, and a header behind it is not the
 * header a user is looking at.
 */
async function openSession(page) {
  const row = page.locator(`[data-testid="collection-chat-${sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();

  const collapse = page.getByTestId('sidebar-collapse-btn');
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click();
  }
}

/**
 * The Terminal input bar's boxes, measured while the terminal view is up. The
 * chat overlay covers the bar, so this has to happen before that toggle. The
 * bar exists at Phone viewport only, which is why no desktop phase calls this.
 */
async function measureInputBar(page) {
  await page.getByTestId('terminal-input-bar').waitFor({ state: 'visible', timeout: 30_000 });
  const boxes = {};
  for (const control of INPUT_BAR_CONTROLS) {
    const locator = page.getByTestId(control.testId).first();
    await locator.waitFor({ state: 'visible', timeout: 30_000 });
    const box = await locator.boundingBox();
    assert.ok(box, `${control.testId} has no layout box, so a finger has nothing to land on`);
    boxes[control.testId] = box;
  }
  return boxes;
}

/** Switches the open terminal session to its chat overlay. */
async function openTerminalChatView(page) {
  const toggle = page.getByTestId('terminal-view-toggle');
  await toggle.waitFor({ state: 'visible', timeout: 30_000 });
  await toggle.click();
  await page.getByTestId('terminal-chat-overlay').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('terminal-chat-composer-send').waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Measures the sidebar controls, then the session ones, and merges the two —
 * at 360px the sidebar and the session header cannot both be on screen.
 */
async function measureEverything(page) {
  await openSidebar(page);
  const sidebar = await measureSurfaces(page, ['sidebar']);
  await openSessionSurfaces(page);
  const session = await measureSurfaces(page, ['session', 'composer']);
  return { ...sidebar, ...session };
}

async function measureSurfaces(page, surfaces) {
  const boxes = {};
  for (const control of CONTROLS.filter((entry) => surfaces.includes(entry.surface))) {
    const locator = page.getByTestId(control.testId).first();
    await locator.waitFor({ state: 'visible', timeout: 30_000 });
    const box = await locator.boundingBox();
    assert.ok(box, `${control.testId} has no layout box, so a finger has nothing to land on`);
    boxes[control.testId] = box;
  }
  return boxes;
}

function describe(boxes) {
  return CONTROLS
    .filter((control) => boxes[control.testId])
    .map((control) => {
      const box = boxes[control.testId];
      return `${control.testId} ${round(box.width)}x${round(box.height)}`;
    })
    .join(', ');
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function capture(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

// ----------------------------------------------------------------- phases ---

/**
 * Phase 1 — at 360px every listed control can actually be hit.
 *
 * Three separate claims, because they fail separately: the boxes are big
 * enough; the four header icons are still four distinct targets rather than
 * one overlapping pile; and the header row still fits, with the provider chip
 * and the session title on screen. The last is the one that would show a
 * "fix" that simply pushed the title out of the viewport.
 */
async function phase1() {
  const { context, page } = await openPhonePage();
  try {
    const boxes = await measureEverything(page);

    const tooSmall = CONTROLS
      .filter((control) => {
        const box = boxes[control.testId];
        const short = box.height + 0.5 < MIN_TOUCH_TARGET;
        const narrow = !control.heightOnly && box.width + 0.5 < MIN_TOUCH_TARGET;
        return short || narrow;
      })
      .map((control) => {
        const box = boxes[control.testId];
        return `${control.testId} (${control.label}) ${round(box.width)}x${round(box.height)}`;
      });
    if (tooSmall.length > 0) await capture(page, 'phone-undersized-targets');
    assert.deepEqual(
      tooSmall,
      [],
      `these controls are smaller than ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET} at`
        + ` ${PHONE_VIEWPORT.width}px, so a finger cannot land on them reliably`,
    );

    assertHeaderTargetsAreDistinct(boxes);
    const header = await assertHeaderStillFits(page, boxes);

    results.push(`phase 1: ${describe(boxes)}`);
    results.push(
      `phase 1: what the header row had left — provider chip ${round(header.badge.width)}px,`
      + ` session title ${round(header.title.width)}px`,
    );
  } finally {
    await context.close();
  }
}

/**
 * The four header icons resolve to four targets. Boxes that merely grew into
 * each other would satisfy the size assertion and still leave "close session"
 * landing on "more options" — which is the failure the ticket describes.
 */
function assertHeaderTargetsAreDistinct(boxes) {
  const overlaps = [];
  for (let i = 0; i < HEADER_CONTROLS.length; i += 1) {
    for (let j = i + 1; j < HEADER_CONTROLS.length; j += 1) {
      const a = boxes[HEADER_CONTROLS[i].testId];
      const b = boxes[HEADER_CONTROLS[j].testId];
      const overlapping = a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlapping) {
        overlaps.push(`${HEADER_CONTROLS[i].testId} overlaps ${HEADER_CONTROLS[j].testId}`);
      }
    }
  }
  assert.deepEqual(overlaps, [], 'two header controls occupy the same pixels');
}

/**
 * The header still fits its 360px row: nothing is pushed past the right edge,
 * the row does not become a horizontal scroller, and the two things the row
 * exists to tell you — which provider, which session — are still on screen.
 */
/** The header row's own geometry: the chip, the title, and what clips them. */
function measureHeaderRow(page) {
  return page.evaluate(() => {
    const handle = document.querySelector('[data-testid="panel-title-drag-handle"]');
    // The chip carries no test id of its own; it is the first element the
    // title button renders, ahead of the title itself.
    const badge = handle?.querySelector('span');
    const title = handle?.querySelector('h2');
    const measure = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: round(box.x), width: round(box.width), right: round(box.right) };
    };
    function round(value) {
      return Math.round(value * 100) / 100;
    }
    const scroller = document.querySelector('[data-testid="chat-layout"]');
    return {
      badge: measure(badge),
      title: measure(title),
      titleButton: measure(handle),
      overflow: scroller
        ? { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
        : null,
    };
  });
}

async function assertHeaderStillFits(page, boxes) {
  const header = await measureHeaderRow(page);

  // One line carrying the whole row, so a failure says what ran out of width
  // rather than only which element lost.
  const geometry = JSON.stringify({
    ...header,
    controls: Object.fromEntries(HEADER_CONTROLS.map((control) => [
      control.testId,
      { x: round(boxes[control.testId].x), right: round(boxes[control.testId].x + boxes[control.testId].width) },
    ])),
  });

  // Every header control inside the viewport, which the size assertion alone
  // does not give: a 44px box pushed past the right edge is still 44px.
  const offScreen = HEADER_CONTROLS
    .filter((control) => {
      const box = boxes[control.testId];
      return box.x < -0.5 || box.x + box.width > PHONE_VIEWPORT.width + 0.5;
    })
    .map((control) => control.testId);
  assert.deepEqual(
    offScreen,
    [],
    `these header controls were pushed outside the ${PHONE_VIEWPORT.width}px row: ${geometry}`,
  );

  assert.ok(header.badge, 'the provider chip was not found in the header');
  assert.ok(header.title, 'the session title was not found in the header');
  assert.ok(
    header.badge.width > 0 && header.badge.right <= PHONE_VIEWPORT.width + 0.5,
    `the provider chip left the ${PHONE_VIEWPORT.width}px row: ${geometry}`,
  );
  assert.ok(
    header.title.width > 0 && header.title.right <= PHONE_VIEWPORT.width + 0.5,
    `the session title left the ${PHONE_VIEWPORT.width}px row: ${geometry}`,
  );
  // A width the row can be squeezed down to and still say which session this
  // is. `width > 0` is not that: the first arrangement of four 44px targets
  // left the title 22px, which shows a character and an ellipsis. It measures
  // 44px now, so this floor has slack for a different font without letting the
  // title be spent again.
  assert.ok(
    header.title.width >= MIN_READABLE_TITLE,
    `the session title was squeezed to ${round(header.title.width)}px, under the`
      + ` ${MIN_READABLE_TITLE}px it needs to name a session: ${geometry}`,
  );
  assert.ok(header.overflow, 'the chat view was not measurable');
  assert.ok(
    header.overflow.scrollWidth <= header.overflow.clientWidth + 1,
    'the chat view was pushed wider than its own box by the enlarged header'
      + ` (content ${header.overflow.scrollWidth}px in ${header.overflow.clientWidth}px)`,
  );

  return header;
}

/**
 * The written provider name is hidden at Phone viewport so the title has room;
 * on a desktop it must still be there. Measured rather than asserted through a
 * class, and taken from the same chip phase 1 measures.
 */
const DESKTOP_PROVIDER_CHIP_WIDTH = 97.13;

async function assertProviderChipKeepsItsNameOnADesktop(page) {
  const header = await measureHeaderRow(page);
  assert.ok(header.badge, 'the provider chip was not found in the header');
  assert.ok(
    Math.abs(header.badge.width - DESKTOP_PROVIDER_CHIP_WIDTH) <= 1,
    `the provider chip is ${round(header.badge.width)}px at ${DESKTOP_VIEWPORT.width}px`
      + ` instead of ${DESKTOP_PROVIDER_CHIP_WIDTH}px; the phone's mark-only chip reached a`
      + ' pointer-driven window',
  );
}

/**
 * Phase 2 — the overriding constraint. At a pointer width every one of these
 * controls measures what it measured before this ticket: a mouse hits 15x15
 * fine, and nothing above the Phone viewport step may move.
 *
 * The baseline is what the unfixed build measured at 1280x900, recorded here
 * rather than derived, so a change that leaked past the breakpoint fails
 * instead of being recomputed into agreement.
 *
 * These are larger than the ticket's numbers because the ticket's numbers were
 * taken at a 13px root font — the 0.8125 font scale — and this fixture runs at
 * the 16px default. Larger text is the tighter case for the header's width, so
 * it is the one worth measuring, and the difference is exactly why the target
 * is stated in px: a `rem` floor is a different number of pixels on each of
 * those two machines.
 *
 * `width: 0` means the control's width is decided by the row it stretches
 * across or by the rendered width of its label, neither of which this ticket
 * touches; its height is the number that was ever in question.
 */
const DESKTOP_BASELINE = {
  'terminal-view-toggle': { width: 18, height: 18 },
  'message-search-open-button': { width: 18, height: 18 },
  'header-more-button': { width: 18, height: 18 },
  'panel-close-button': { width: 18, height: 18 },
  'terminal-chat-composer-send': { width: 26, height: 26 },
  'terminal-chat-back-to-terminal': { width: 0, height: 16.5 },
  'collection-quick-create-toggle-__uncategorized': { width: 18, height: 18 },
  'sidebar-collapse-btn': { width: 24, height: 24 },
  'sidebar-all-filter': { width: 0, height: 20 },
  'sidebar-running-filter': { width: 0, height: 20 },
};

async function phase2() {
  const { context, page } = await openDesktopPage();
  try {
    const boxes = await measureEverything(page);

    const moved = CONTROLS
      .filter((control) => {
        const box = boxes[control.testId];
        const expected = DESKTOP_BASELINE[control.testId];
        const heightMoved = Math.abs(box.height - expected.height) > 0.75;
        const widthMoved = expected.width > 0 && Math.abs(box.width - expected.width) > 0.75;
        return heightMoved || widthMoved;
      })
      .map((control) => {
        const box = boxes[control.testId];
        const expected = DESKTOP_BASELINE[control.testId];
        return `${control.testId}: ${round(box.width)}x${round(box.height)}`
          + ` (was ${expected.width || '*'}x${expected.height})`;
      });
    if (moved.length > 0) await capture(page, 'desktop-controls-moved');
    assert.deepEqual(
      moved,
      [],
      `these controls changed size at ${DESKTOP_VIEWPORT.width}px;`
        + ' the phone work must not reach a pointer-driven window',
    );

    await assertProviderChipKeepsItsNameOnADesktop(page);

    results.push(`phase 2: ${describe(boxes)}`);
  } finally {
    await context.close();
  }
}

/**
 * Phase 3 — the same floor at the font scale the whole problem hides behind.
 *
 * Two claims. The Terminal input bar's own controls reach 44px, which is the
 * #243 shortfall this ticket absorbed. And the ten controls from phase 1 are
 * still 44px here, which is the argument for stating the floor in px rather
 * than `rem`: a `rem` floor would have shrunk with the setting, and this is
 * exactly the setting the ticket's own measurements were taken at.
 */
async function phase3() {
  await setFontScale(SMALLEST_FONT_SCALE);
  const { context, page } = await openPhonePage();
  try {
    await openSidebar(page);
    const sidebar = await measureSurfaces(page, ['sidebar']);
    await openSession(page);
    const bar = await measureInputBar(page);
    await openTerminalChatView(page);
    const session = await measureSurfaces(page, ['session', 'composer']);
    const boxes = { ...sidebar, ...session };

    const root = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    assert.equal(
      root,
      '13px',
      `the font scale did not reach the page (root font ${root}); without it this phase`
        + ' measures the default scale and proves nothing',
    );

    const tooSmall = [...INPUT_BAR_CONTROLS, ...CONTROLS]
      .map((control) => ({ control, box: bar[control.testId] ?? boxes[control.testId] }))
      .filter(({ control, box }) => (
        box.height + 0.5 < MIN_TOUCH_TARGET
        || (!control.heightOnly && box.width + 0.5 < MIN_TOUCH_TARGET)
      ))
      .map(({ control, box }) => (
        `${control.testId} (${control.label}) ${round(box.width)}x${round(box.height)}`
      ));
    if (tooSmall.length > 0) await capture(page, 'phone-undersized-at-smallest-font-scale');
    assert.deepEqual(
      tooSmall,
      [],
      `these controls are smaller than ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET} at`
        + ` ${PHONE_VIEWPORT.width}px and font scale ${SMALLEST_FONT_SCALE}`,
    );

    results.push(`phase 3: at font scale ${SMALLEST_FONT_SCALE} (13px root) — ${describeBar(bar)}`);
  } finally {
    await context.close();
    await setFontScale(1);
  }
}

/** The user setting the root font is computed from (`theme-initializer.tsx`). */
async function setFontScale(scale) {
  const response = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ fontSize: scale }),
  });
  assert.equal(response.ok, true, `could not set the font scale: ${response.text}`);
}

function describeBar(bar) {
  return INPUT_BAR_CONTROLS
    .map((control) => `${control.testId.replace('terminal-input-bar-', '')} `
      + `${round(bar[control.testId].width)}x${round(bar[control.testId].height)}`)
    .join(', ');
}

// ------------------------------------------------------------------- main ---

try {
  await prepareFixture();
  await writeBrowserUser();
  await startServer();
  await registerProject();
  sessionId = await createSession();

  browser = await chromium.launch({ headless });

  if (shouldRun(1)) await phase1();
  if (shouldRun(2)) await phase2();
  // Last: it changes a server-side setting, and restores it in its own finally.
  if (shouldRun(3)) await phase3();
} catch (error) {
  process.stderr.write(`\n--- isolated server output ---\n${logs()}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtureDir, { recursive: true, force: true });
}

for (const line of results) console.log(`ok — ${line}`);
console.log(`ok — ${CONTROLS.length} controls measured on a phone and on a desktop`);
