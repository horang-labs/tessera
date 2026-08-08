/**
 * End-to-end coverage for the message action row that runs off a 360px screen (#261).
 *
 * QA measured the assistant row — Copy · Translate · From here — at left=149
 * right=380 on a 360px viewport: 20px of it, and half of "From here", painted
 * outside the screen with nothing scrollable to reach it. The row is
 * `ml-auto inline-flex shrink-0 …`, so it is pinned to the right of a container
 * it is too wide for and cannot give any width back.
 *
 * The conversation is real, not a probe: a seeded canonical history JSONL is
 * replayed through `/api/sessions/[id]/messages` and rendered by the chat view,
 * so what is measured is the element a finger would land on. Both shapes are
 * covered, because they come from different files — the grouped agent turn
 * (`agent-message-group.tsx`) and the standalone assistant bubble
 * (`message-bubble-content.tsx`) — plus the user row, which fits today and must
 * keep fitting.
 *
 *   1. Phone viewport (360x880, touch), default font scale: every action row's
 *      own box, and every button inside it, lies within the viewport; the three
 *      assistant actions are all present; the page does not scroll sideways.
 *   2. The same at both ends of FONT_SCALE_OPTIONS. The row is sized in `rem`
 *      (`w-[4.75rem]`, `w-[6.25rem]`), so at 1.375 it is ~390px of buttons in a
 *      300px column — a fix that only clears the default scale is not a fix.
 *      0.8125 is the scale QA's own numbers were taken at (231px = 284 x 0.8125).
 *   3. Desktop width (1280x900, no touch): the row is still one line, still
 *      Copy → Translate → From here in that order, and still ends where it
 *      ended before. Nothing above the Phone viewport step may move.
 *
 * The server runs from the repository itself, not from a copied app root:
 * every assertion here is a measured box, and Tailwind only generates its
 * utility layer for the source tree it is pointed at. Against a copy the page
 * arrives with no utilities at all and every box measures as its content
 * (#252).
 *
 * What this file deliberately does not settle: whether the wrapped row reads as
 * one group of actions under a real thumb, and whether a tap lands on the
 * intended button when two of them are 16px tall. The height is #259's ticket,
 * not this one.
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
 * Both ends of FONT_SCALE_OPTIONS (`src/lib/settings/provider-defaults.ts`),
 * with the default in the middle. The row's buttons are `rem`-sized, so each of
 * these is a different pixel count for the same class: the three assistant
 * buttons are 231px at 0.8125, 284px at 1, and 390.5px at 1.375, against a
 * column that is 300px wide at 360px whatever the scale. Only the largest is
 * wide enough to need the row itself to wrap.
 */
const FONT_SCALES = [
  { scale: 0.8125, rootFontSize: '13px', note: "QA's own measurement scale" },
  { scale: 1, rootFontSize: '16px', note: 'the default' },
  { scale: 1.375, rootFontSize: '22px', note: 'the largest offered' },
];

/**
 * The three actions, by the text they carry. Read off the rendered buttons
 * rather than a test id per button: the ticket's claim is that all three are
 * *reachable*, and a button that renders is only reachable if its box is on
 * screen, which is what each entry is checked for.
 */
const ASSISTANT_ACTION_LABELS = ['Copy', 'Translate', 'From here'];

/**
 * Headful by default, for the same reason #259 is: every assertion here is a
 * box a person is meant to be able to hit, and headless Chromium has its device
 * metrics injected rather than read from a display. #256 was filed and closed as
 * an artifact of exactly that. `TESSERA_E2E_HEADED=0` is the escape hatch for a
 * machine with no display, and a run that takes it is not evidence about layout.
 */
const headless = process.env.TESSERA_E2E_HEADED === '0';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-phone-action-row-e2e');
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-action-row-data-'));
const fixtureDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-action-row-fixture-'));
const projectDir = path.join(fixtureDir, `action-row-e2e-${path.basename(fixtureDir).slice(-6)}`);

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

function round(value) {
  return Math.round(value * 100) / 100;
}

// --------------------------------------------------------------- fixtures ---

/** One ordinary git repository, so the app will accept and open a project. */
async function prepareFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# action row e2e\n', 'utf8');
}

/**
 * One user turn and one assistant turn, written straight into the canonical
 * history the read path replays (`sessionHistory.getHistoryPath`). No runtime is
 * spawned and nothing is streamed: the chat view renders these through the same
 * reducer a live conversation goes through.
 *
 * The assistant text is short on purpose. A long answer would let the bubble
 * decide the row's width and hide whether the header row itself fits.
 */
async function seedHistory() {
  const historyDir = path.join(dataDir, 'session-history');
  await fs.mkdir(historyDir, { recursive: true });
  const events = [
    {
      v: 1,
      type: 'user_message',
      timestamp: '2026-08-08T01:00:00.000Z',
      content: 'hello',
      messageId: 'action-row-user-1',
    },
    {
      v: 1,
      type: 'assistant_message',
      timestamp: '2026-08-08T01:00:01.000Z',
      content: 'hi',
      messageId: 'action-row-assistant-1',
    },
  ];
  await fs.writeFile(
    path.join(historyDir, `${sessionId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
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
      // session list this conversation is opened from.
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
 * The account the browser's cookie will name. Written before the server starts,
 * because the request gate looks the token's subject up in this file and an
 * Electron-runtime server creates no account of its own.
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
 * A `gui` session, not a `pty` one: a terminal session's history is decoded
 * from the provider's own transcript instead of the canonical JSONL this file
 * seeds, and there is no provider transcript here.
 */
async function createSession() {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: projectDir,
      parentProjectId: projectDir,
      providerId: 'claude-code',
      executionMode: 'gui',
      title: 'action row e2e',
      hasCustomTitle: true,
    }),
  });
  assert.equal(response.ok, true, `could not create a session: ${response.text}`);
  const id = response.json?.sessionId ?? response.json?.session?.id ?? response.json?.id;
  assert.ok(id, `the session response carried no id: ${response.text}`);
  return id;
}

/** The user setting the root font is computed from (`theme-initializer.tsx`). */
async function setFontScale(scale) {
  const response = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ fontSize: scale }),
  });
  assert.equal(response.ok, true, `could not set the font scale: ${response.text}`);
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
 * Opens the seeded conversation with the sidebar out of the way — at 360px it
 * takes the whole width, and a message row behind it is not the row a user is
 * looking at.
 *
 * 'load' rather than 'domcontentloaded': every box measured here is a styled
 * box, and an unstyled row measures as its content.
 */
async function openConversation(page) {
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

  const row = page.locator(`[data-testid="collection-chat-${sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();

  const collapse = page.getByTestId('sidebar-collapse-btn');
  if (await collapse.isVisible().catch(() => false)) {
    await collapse.click();
  }

  // The seeded turns arrive through the messages route, not with the shell.
  await page.locator('[data-testid="message-actions"]').first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  // `transition-opacity` on the row: a box read while it is still fading in is
  // measurable, but the screenshot beside it would not show what a user sees.
  await page.waitForTimeout(400);
}

/**
 * Every action row on screen, with the buttons inside it.
 *
 * Measured through `getBoundingClientRect()` on the row's own element and on
 * each button's own element — the ticket's numbers are row boxes, and a row
 * inside the viewport whose third button is not would still be the reported
 * defect.
 */
function measureActionRows(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const measure = (element) => {
      const box = element.getBoundingClientRect();
      return {
        left: round(box.left),
        right: round(box.right),
        top: round(box.top),
        bottom: round(box.bottom),
        width: round(box.width),
        height: round(box.height),
      };
    };
    return [...document.querySelectorAll('[data-testid="message-actions"]')].map((row) => {
      const owner = row.closest('[data-testid="agent-message-group"]')
        ? 'agent group'
        : row.closest('[data-testid="user-message-row"]')
          ? 'user message'
          : 'assistant bubble';
      return {
        owner,
        ...measure(row),
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        buttons: [...row.querySelectorAll('button')].map((button) => ({
          label: (button.textContent ?? '').trim(),
          ...measure(button),
        })),
      };
    });
  });
}

/** Whether the page itself gained a sideways scroll, which #245 already settled. */
function measurePageOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function capture(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

function describeRows(rows) {
  return rows
    .map((row) => `${row.owner} left=${row.left} right=${row.right}`
      + ` [${row.buttons.map((button) => `${button.label} ${button.left}..${button.right}`).join(', ')}]`)
    .join('; ');
}

// ------------------------------------------------------------ assertions ---

/**
 * The ticket's own criterion, applied to the row and to each button in it.
 *
 * Half a pixel of tolerance because a fractional layout can round a box's right
 * edge onto the viewport boundary; 20px of overflow is what is being caught.
 */
function assertEverythingIsOnScreen(rows, width, context) {
  const escaped = [];
  for (const row of rows) {
    if (row.left < -0.5 || row.right > width + 0.5) {
      escaped.push(`the ${row.owner} row itself (${row.left}..${row.right})`);
    }
    for (const button of row.buttons) {
      if (button.left < -0.5 || button.right > width + 0.5) {
        escaped.push(`"${button.label}" in the ${row.owner} row (${button.left}..${button.right})`);
      }
    }
  }
  assert.deepEqual(
    escaped,
    [],
    `these boxes are painted outside the ${width}px viewport ${context},`
      + ` so nothing can tap them: ${describeRows(rows)}`,
  );
}

/**
 * The assistant rows still offer all three actions. The width fix must not have
 * been bought by dropping one — the ticket rules that out explicitly, and a row
 * with two buttons fits without any layout work at all.
 */
function assertAllThreeActionsExist(rows, context) {
  const assistantRows = rows.filter((row) => row.owner !== 'user message');
  assert.ok(
    assistantRows.length > 0,
    `no assistant action row was rendered ${context}; there is nothing to measure`,
  );
  for (const row of assistantRows) {
    const labels = row.buttons.map((button) => button.label);
    const missing = ASSISTANT_ACTION_LABELS.filter(
      (wanted) => !labels.some((label) => label.includes(wanted)),
    );
    assert.deepEqual(
      missing,
      [],
      `the ${row.owner} row lost ${missing.join(' and ')} ${context};`
        + ` it offers ${JSON.stringify(labels)}`,
    );
  }
}

/**
 * The user row is the one the ticket said to leave alone, and "alone" is a
 * layout claim, not just an on-screen one: it was a single line before this
 * change and has to stay one at the width and scale it was measured at.
 *
 * This exists because removing the header's `flex-wrap` — which a reviewer
 * argued for, since no acceptance criterion needs it — measurably makes this row
 * worse. `shrink-0` is shared through MESSAGE_ACTIONS_CLASS, so without a line of
 * its own the row is squeezed on the name line and breaks in two: Copy 259..335
 * with From here 235..335 beneath it, against one line of Copy 155..231 and
 * From here 235..335 with it. Every other assertion in this file passes either
 * way, which is exactly why this one is written down.
 */
function assertTheUserRowStillFitsOnOneLine(rows) {
  const userRow = rows.find((row) => row.owner === 'user message');
  assert.ok(userRow, 'no user action row was rendered; there is nothing to compare');
  const lines = [...new Set(userRow.buttons.map((button) => round(button.top)))];
  assert.equal(
    lines.length,
    1,
    `the user row's actions wrapped onto ${lines.length} lines at the default font scale;`
      + ' it was one line before this ticket and the ticket asked for it to be left alone:'
      + ` ${describeRows([userRow])}`,
  );
}

function assertPageDoesNotScrollSideways(overflow, width) {
  assert.ok(
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `the page became a horizontal scroller at ${width}px`
      + ` (content ${overflow.scrollWidth}px in ${overflow.clientWidth}px)`,
  );
}

// ----------------------------------------------------------------- phases ---

/**
 * Phase 1 — the ticket, at 360px and the default font scale.
 *
 * The screenshot is taken on every run, pass or fail: a geometry check that
 * passes is not proof the row reads correctly, and this one can be satisfied by
 * a row that fits and looks wrong.
 */
async function phase1() {
  await setFontScale(1);
  const { context, page } = await openPhonePage();
  try {
    await openConversation(page);
    const rows = await measureActionRows(page);
    const shot = await capture(page, 'phone-action-row-default-scale');

    assertAllThreeActionsExist(rows, 'at the default font scale');
    assertEverythingIsOnScreen(rows, PHONE_VIEWPORT.width, 'at the default font scale');
    assertPageDoesNotScrollSideways(await measurePageOverflow(page), PHONE_VIEWPORT.width);
    assertTheUserRowStillFitsOnOneLine(rows);

    results.push(`phase 1: at ${PHONE_VIEWPORT.width}px — ${describeRows(rows)}`);
    results.push(`phase 1: screenshot at ${shot}`);
  } finally {
    await context.close();
  }
}

/**
 * Phase 2 — the same claim at both ends of the font-scale setting.
 *
 * The root font size is asserted first. Without it a phase that failed to apply
 * the setting would measure the default scale three times and report three
 * passes, which is how a `rem`-shaped defect survives its own test.
 */
async function phase2() {
  for (const { scale, rootFontSize, note } of FONT_SCALES) {
    await setFontScale(scale);
    const { context, page } = await openPhonePage();
    try {
      await openConversation(page);

      const root = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
      assert.equal(
        root,
        rootFontSize,
        `font scale ${scale} did not reach the page (root font ${root}); without it this`
          + ' phase measures the default scale and proves nothing',
      );

      const rows = await measureActionRows(page);
      const where = `at font scale ${scale} (${note})`;
      // Captured on every run, pass or fail: a row that fits can still be a row
      // nobody can read, and the numbers below cannot tell the difference.
      const shot = await capture(page, `phone-action-row-at-scale-${scale}`);
      assertAllThreeActionsExist(rows, where);
      assertEverythingIsOnScreen(rows, PHONE_VIEWPORT.width, where);
      assertPageDoesNotScrollSideways(await measurePageOverflow(page), PHONE_VIEWPORT.width);

      const widest = Math.max(...rows.map((row) => row.right));
      const lines = Math.max(...rows.map(
        (row) => new Set(row.buttons.map((button) => round(button.top))).size,
      ));
      results.push(`phase 2: font scale ${scale} (${rootFontSize} root) — widest row right edge`
        + ` ${round(widest)} of ${PHONE_VIEWPORT.width}, deepest row wraps onto ${lines}`
        + ` line(s), screenshot at ${shot}`);
    } finally {
      await context.close();
    }
  }
  await setFontScale(1);
}

/**
 * What the unfixed build measured at 1280x900 and the default font scale, so a
 * change that leaked past the Phone viewport step fails here instead of being
 * recomputed into agreement.
 *
 * Recorded as the row's width and the gaps between its buttons rather than
 * absolute x positions: the chat column's left edge depends on the sidebar
 * state, and the ticket's desktop criterion is about the row's own arrangement.
 */
const DESKTOP_ROW_WIDTH = 284;

async function phase3() {
  await setFontScale(1);
  const { context, page } = await openDesktopPage();
  try {
    await openConversation(page);
    const rows = await measureActionRows(page);
    await capture(page, 'desktop-action-row');

    assertAllThreeActionsExist(rows, `at ${DESKTOP_VIEWPORT.width}px`);
    assertEverythingIsOnScreen(rows, DESKTOP_VIEWPORT.width, `at ${DESKTOP_VIEWPORT.width}px`);

    const assistantRows = rows.filter((row) => row.owner !== 'user message');
    for (const row of assistantRows) {
      // One line: every button shares the row's top. A wrapped desktop row would
      // pass every "is it on screen" check and still be the regression.
      const tops = [...new Set(row.buttons.map((button) => round(button.top)))];
      assert.equal(
        tops.length,
        1,
        `the ${row.owner} row wrapped onto ${tops.length} lines at ${DESKTOP_VIEWPORT.width}px;`
          + ` the phone work must not reach a pointer-driven window: ${describeRows([row])}`,
      );

      // Same order, left to right.
      const order = row.buttons
        .slice()
        .sort((a, b) => a.left - b.left)
        .map((button) => ASSISTANT_ACTION_LABELS.find((label) => button.label.includes(label)));
      assert.deepEqual(
        order,
        ASSISTANT_ACTION_LABELS,
        `the ${row.owner} row reordered its actions at ${DESKTOP_VIEWPORT.width}px`,
      );

      assert.ok(
        Math.abs(row.width - DESKTOP_ROW_WIDTH) <= 1,
        `the ${row.owner} row is ${row.width}px wide at ${DESKTOP_VIEWPORT.width}px instead of`
          + ` ${DESKTOP_ROW_WIDTH}px; the phone work changed a pointer-driven window`,
      );
    }

    results.push(`phase 3: at ${DESKTOP_VIEWPORT.width}px — ${describeRows(rows)}`);
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------- main ---

try {
  await prepareFixture();
  await writeBrowserUser();
  await startServer();
  await registerProject();
  sessionId = await createSession();
  await seedHistory();

  browser = await chromium.launch({ headless });

  if (shouldRun(1)) await phase1();
  if (shouldRun(2)) await phase2();
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
console.log(
  `ok — the message action row measured at ${PHONE_VIEWPORT.width}px across`
  + ` ${FONT_SCALES.length} font scales and at ${DESKTOP_VIEWPORT.width}px`,
);
