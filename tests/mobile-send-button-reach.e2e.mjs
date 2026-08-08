/**
 * End-to-end coverage for reaching the send button at a narrow width (#251).
 *
 * The composer's textarea would not shrink below its intrinsic width, so the
 * right-hand controls — the send button last of all — were pushed off the right
 * edge of the screen. This file measures what a user can reach:
 *
 *   1. Phone viewport (360x880, touch): the send button's box lies inside the
 *      viewport, the chat view does not scroll horizontally, and the textarea
 *      is still wide enough to type into.
 *   2. Desktop width (1280x900, no touch): the composer is laid out exactly as
 *      before — the fix must be invisible where width is ample.
 *
 * The server runs from the repository itself, not from a copy: every assertion
 * here is a measured box, and Tailwind only generates its utility layer for the
 * source tree it is pointed at. A copied app root serves the page unstyled, and
 * an unstyled composer measures as its content (#252).
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
import jwt from 'jsonwebtoken';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const run = promisify(execFile);

/** A pointer-driven window, which is what must not regress. */
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-mobile-send-button-e2e');
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-send-button-data-'));
const fixtureDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-send-button-fixture-'));
const projectDir = path.join(fixtureDir, `send-button-e2e-${path.basename(fixtureDir).slice(-6)}`);

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
 * One ordinary git repository. Nothing is committed to or branched — the project
 * only has to be something the app will accept, list, and open a session on.
 */
async function prepareFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# send button e2e\n', 'utf8');
}

// ----------------------------------------------------------------- server ---

async function startServer() {
  const env = { ...process.env };
  // This suite may itself be running inside Tessera; nothing about the host
  // app's session may leak into the server under test.
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
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
      // session list the composer is opened from.
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
      PORT: String(port),
      TESSERA_DEV_PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
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
      // Mutating routes check the origin; fetch does not set one for us the way
      // a browser would.
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
 * One chat session, which is what puts the composer on screen. No message is
 * ever sent, so nothing spawns a CLI runtime.
 */
async function createSession() {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: projectDir,
      parentProjectId: projectDir,
      providerId: 'claude-code',
      // The composer belongs to the chat view; a pty session shows a terminal
      // surface and no textarea at all.
      executionMode: 'gui',
      title: 'send button e2e',
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
 * Opens the fixture session's chat view and returns its composer textarea.
 *
 * 'load' rather than 'domcontentloaded': every box measured here is a styled
 * box, and an unstyled composer measures as its content.
 */
async function openComposer(page) {
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

  const textarea = page.locator(
    `textarea[data-session-input=${JSON.stringify(sessionId)}]`,
  ).first();
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  return textarea;
}

/** The composer row under test: the textarea and its neighbouring controls. */
function composerRow(page) {
  return page.locator(`textarea[data-session-input=${JSON.stringify(sessionId)}]`)
    .locator('xpath=ancestor::*[@data-testid="message-input-row"][1]');
}

function sendButton(page) {
  return composerRow(page).getByTestId('message-send-btn');
}

/**
 * How far past its own box each container the composer sits in is pushed.
 *
 * The document scroller alone would prove nothing: the chat view's root clips
 * (`overflow-hidden`), so a composer wide enough to push the send button off the
 * screen still leaves `document.scrollingElement` exactly the viewport's width.
 * The clipping is why the button becomes unreachable rather than scrollable-to,
 * so the containers that do the clipping have to be measured themselves.
 */
function horizontalOverflow(page) {
  return page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const measure = (element) => (element ? {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    } : null);
    return {
      document: measure(scroller),
      chatView: measure(document.querySelector('[data-testid="chat-layout"]')),
      composerRow: measure(document.querySelector('[data-testid="message-input-row"]')),
    };
  });
}

function assertNoHorizontalOverflow(overflow, where) {
  for (const [name, box] of Object.entries(overflow)) {
    assert.ok(box, `${name} was not measurable`);
    assert.ok(
      box.scrollWidth <= box.clientWidth + 1,
      `${name} was pushed wider than its own box ${where}`
        + ` (content ${box.scrollWidth}px in ${box.clientWidth}px)`,
    );
  }
}

async function capture(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

// ----------------------------------------------------------------- phases ---

/**
 * Phase 1 — at 360px the send button is on screen and the view does not scroll
 * sideways, while the textarea is still wide enough to type into.
 *
 * The composer is filled first, and not for the sake of having typed something.
 * A textarea's intrinsic width is its default 20 columns of whatever font the
 * device renders, and at 360px that leaves the row with no slack at all: the
 * paperclip, the un-shrinkable wrapper and the right-hand controls add up to
 * exactly the width available. Anything that asks for one more pixel — the
 * character counter appearing, a wider system font — pushes the controls out,
 * and the send button, being last, goes first. Filling past the counter's
 * threshold is the cheapest way to ask for that pixel using only the composer's
 * own UI, and it is an ordinary thing to do on a phone: paste a long log.
 *
 * Both assertions were watched failing on the unfixed build in this state: the
 * send button's box ended at x=364.18 in a 360px viewport, and the composer row
 * demanded 355px inside its 324px box.
 */
async function phase1() {
  const { context, page } = await openPhonePage();
  try {
    const textarea = await openComposer(page);
    await textarea.fill('x'.repeat(9500));
    await page.getByTestId('message-input-char-count').waitFor({ timeout: 5_000 });

    const box = await sendButton(page).boundingBox();
    assert.ok(box, 'the send button had no layout box');
    if (box.x < 0 || box.x + box.width > PHONE_VIEWPORT.width) {
      await capture(page, 'phone-send-button-offscreen');
    }
    assert.ok(
      box.x >= 0 && box.x + box.width <= PHONE_VIEWPORT.width,
      `the send button was outside the ${PHONE_VIEWPORT.width}px viewport: ${JSON.stringify(box)}`,
    );

    // Measured in the filled state, which is the state the slack disappears in.
    const overflow = await horizontalOverflow(page);
    assertNoHorizontalOverflow(overflow, `at ${PHONE_VIEWPORT.width}px`);

    // Shrinking is only a fix if what shrank is still usable.
    const textareaBox = await textarea.boundingBox();
    assert.ok(textareaBox, 'the composer textarea had no layout box');
    assert.ok(
      textareaBox.width >= 120,
      `the composer textarea shrank past usefulness: ${textareaBox.width}px`,
    );
    assert.ok(
      textareaBox.x + textareaBox.width <= PHONE_VIEWPORT.width,
      `the composer textarea itself overflowed: ${JSON.stringify(textareaBox)}`,
    );

    await textarea.fill('hello from a phone');
    assert.equal(
      await textarea.inputValue(),
      'hello from a phone',
      'the composer textarea did not accept typing',
    );

    results.push({ phase: 1, sendButton: box, textarea: textareaBox, overflow });
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Phase 2 — the overriding constraint for this wave: the desktop composer must
 * not regress, and "pixel-identical to before" is asserted rather than argued.
 *
 * Both sides of "before and after" are measured in the same page, by taking the
 * three utilities this ticket added off the live elements, measuring, putting
 * them back and measuring again. A recorded baseline would compare across
 * machines and fonts; this compares the only two things the criterion is about,
 * under identical conditions. It is the one place in this file that names the
 * utilities, and it names them because they are what is being switched off.
 */
async function phase2() {
  const { context, page } = await openDesktopPage();
  try {
    await openComposer(page);

    const before = await measureComposer(page, { withFix: false });
    const after = await measureComposer(page, { withFix: true });

    for (const part of ['row', 'textarea', 'sendButton']) {
      for (const edge of ['x', 'y', 'width', 'height']) {
        assert.equal(
          after[part][edge].toFixed(2),
          before[part][edge].toFixed(2),
          `the desktop composer moved when the fix was applied:`
            + ` ${part}.${edge} ${before[part][edge]} -> ${after[part][edge]}`,
        );
      }
    }

    // And it is laid out the way it is supposed to be, not identically broken.
    assert.ok(
      after.textarea.width > after.row.width / 2,
      `the desktop textarea stopped filling the row:`
        + ` ${after.textarea.width}px of ${after.row.width}px`,
    );
    assert.ok(
      after.sendButton.x + after.sendButton.width <= after.row.x + after.row.width + 1,
      `the desktop send button left the row: ${JSON.stringify(after.sendButton)}`,
    );

    assertNoHorizontalOverflow(await horizontalOverflow(page), 'at desktop width');

    results.push({ phase: 2, before, after });
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Measures the composer with this ticket's three utilities either off or on.
 *
 * The wrapper and the controls container are reached through the textarea and
 * the send button rather than by class, so only the utilities under test are
 * named here.
 */
function measureComposer(page, { withFix }) {
  return page.evaluate((applyFix) => {
    const row = document.querySelector('[data-testid="message-input-row"]');
    const textarea = row.querySelector('textarea[data-session-input]');
    const sendButton = row.querySelector('[data-testid="message-send-btn"]');
    textarea.parentElement.classList.toggle('min-w-0', applyFix);
    textarea.classList.toggle('min-w-0', applyFix);
    sendButton.parentElement.classList.toggle('shrink-0', applyFix);

    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { row: box(row), textarea: box(textarea), sendButton: box(sendButton) };
  }, withFix);
}

// ------------------------------------------------------------------- main ---

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

let failure = null;
try {
  await prepareFixture();
  await writeBrowserUser();
  await startServer();
  await registerProject();
  sessionId = await createSession();

  browser = await launchPhoneBrowser();

  if (shouldRun(1)) await phase1();
  if (shouldRun(2)) await phase2();

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  failure = error;
  console.error(error);
  console.error(`--- server log tail ---\n${logs().slice(-8000)}`);
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

if (failure) process.exit(1);
