/**
 * End-to-end coverage for reaching the new-session sheet on a phone (#244).
 *
 * The + control that opens the sheet used to exist only on hover, and a phone
 * has no hover. Two phases, both against a real server and a real browser:
 *
 *   1. Phone viewport (360x880, touch): the + control is visible without any
 *      hover interaction.
 *   2. Desktop width (1280x900, no touch): the same control is still revealed
 *      by hover and still hidden without it — the desktop layout must not
 *      regress.
 *
 * What this suite deliberately cannot settle: whether the sheet *stays open*
 * once tapped. Playwright's synthetic taps reproduce neither Android Chrome's
 * sticky hover nor its synthetic-event sequence, so that acceptance criterion
 * is device-only and is not asserted here.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1 while iterating.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import jwt from 'jsonwebtoken';

const run = promisify(execFile);

const port = Number(process.env.TESSERA_E2E_PORT ?? 34244);
const origin = `http://127.0.0.1:${port}`;
const headless = process.env.TESSERA_E2E_HEADED !== '1';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-mobile-sheet-e2e');
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

/**
 * The seam this wave shares: one 360x880 context with touch enabled, which is
 * the Galaxy Z Flip main display the spec targets.
 */
const PHONE_CONTEXT = { viewport: { width: 360, height: 880 }, hasTouch: true };
/** A pointer-driven window, which is what must not regress. */
const DESKTOP_CONTEXT = { viewport: { width: 1280, height: 900 }, hasTouch: false };

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-mobile-sheet-data-'));
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-mobile-sheet-fixture-'));
const projectDir = path.join(fixtureDir, `sheet-e2e-${path.basename(fixtureDir).slice(-6)}`);

const serverOutput = [];
let server = null;
let browser = null;
let appSecret = null;
let collectionId = null;
const results = [];

function shouldRun(phase) {
  return selectedPhases.length === 0 || selectedPhases.includes(String(phase));
}

function logs() {
  return serverOutput.join('');
}

// --------------------------------------------------------------- fixtures ---

/**
 * One ordinary git repository. Nothing here is committed to or branched — the
 * project only has to be something the app will accept and list.
 */
async function prepareFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# new-session sheet e2e\n', 'utf8');
}

// ---------------------------------------------------------------- server ---

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
      // collection list it renders the + control from.
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

// ------------------------------------------------------------------ http ---

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
 * One collection, which is what puts a header — and therefore a + control — in
 * the sidebar. It is left empty on purpose: an empty collection still renders
 * its header, and no session is created, so nothing spawns a CLI runtime.
 */
async function createCollection() {
  const response = await api('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectDir, label: 'Sheet E2E', color: '#7c3aed' }),
  });
  assert.equal(response.ok, true, `could not create a collection: ${response.text}`);
  const id = response.json?.collection?.id;
  assert.ok(id, `the collection response carried no id: ${response.text}`);
  return id;
}

// -------------------------------------------------------------------- ui ---

async function openContext(options) {
  const token = await mintBrowserToken();
  const context = await browser.newContext({
    ...options,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addCookies([
    { name: 'jwt', value: token, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));
  return { context, page };
}

/**
 * Opens the sidebar's list view on the fixture project.
 *
 * Below 1024px the shell forces the sidebar collapsed to the project strip, so
 * on a phone the list has to be opened before anything in it can be reached.
 */
async function openCollectionList(page) {
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });

  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();

  // The expand control only exists while the sidebar is collapsed, which the
  // shell forces below 1024px and remembers across contexts.
  await page.waitForTimeout(500);
  const expand = page.locator('[data-testid="tab-bar-sidebar-toggle"]');
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }

  const header = page.locator(`[data-testid="collection-header-${collectionId}"]`);
  await header.waitFor({ state: 'visible', timeout: 30_000 });
  return header;
}

/**
 * Whether the user could actually see the control.
 *
 * `toBeVisible` ignores opacity, and an `opacity-0` button is exactly the
 * defect under test, so the browser's own visibility check is asked instead.
 */
function isActuallyVisible(page, testid) {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return false;
    return element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    });
  }, testid);
}

async function capture(page, name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

// ----------------------------------------------------------------- phases ---

/**
 * Phase 1 — at Phone viewport the + control is visible with no hover at all.
 *
 * The pointer is parked in a corner and never moved over the header, so a
 * sticky-hover state cannot account for a pass.
 */
async function phase1() {
  const { context, page } = await openContext(PHONE_CONTEXT);
  try {
    await openCollectionList(page);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);

    const testid = `collection-quick-create-toggle-${collectionId}`;
    const visible = await isActuallyVisible(page, testid);
    if (!visible) await capture(page, 'phone-plus-invisible');
    assert.equal(visible, true, 'the + control was not visible at 360px without hover');

    // Being visible is not enough if it sits off the edge of the screen.
    const box = await page.locator(`[data-testid="${testid}"]`).boundingBox();
    assert.ok(box, 'the + control had no layout box');
    assert.ok(
      box.x >= 0 && box.x + box.width <= 360,
      `the + control was outside the 360px viewport: ${JSON.stringify(box)}`,
    );

    results.push({ phase: 1, visibleWithoutHover: true, box });
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Phase 2 — at desktop width the hover reveal is unchanged.
 *
 * Both halves matter: still hidden with the pointer away, still revealed when
 * the pointer is on the collection header.
 */
async function phase2() {
  const { context, page } = await openContext(DESKTOP_CONTEXT);
  try {
    const header = await openCollectionList(page);
    const testid = `collection-quick-create-toggle-${collectionId}`;

    await page.mouse.move(1200, 850);
    await page.waitForTimeout(400);
    const beforeHover = await isActuallyVisible(page, testid);
    if (beforeHover) await capture(page, 'desktop-plus-visible-without-hover');
    assert.equal(beforeHover, false, 'the + control was visible at desktop width without hover');

    await header.hover();
    await page.waitForTimeout(400);
    const afterHover = await isActuallyVisible(page, testid);
    if (!afterHover) await capture(page, 'desktop-plus-missing-on-hover');
    assert.equal(afterHover, true, 'hovering the collection header did not reveal the + control');

    results.push({ phase: 2, hiddenWithoutHover: true, revealedOnHover: true });
  } finally {
    await context.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ main ---

let failure = null;
try {
  await prepareFixture();
  await writeBrowserUser();
  await startServer();
  await registerProject();
  collectionId = await createCollection();

  browser = await chromium.launch({ headless });

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
