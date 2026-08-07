/**
 * Phone viewport, and the kanban staying off phones (issue #242).
 *
 * The whole ticket is verifiable through one browser context: 360x880 with
 * touch, the Galaxy Z Flip main display. Everything asserted here is what a
 * user can see or reach — a control present or absent from the tree, a box
 * inside the viewport, a stored value unchanged — never a class name.
 *
 * The desktop check runs in a second context at 1000px, which is a Compact
 * viewport but not a Phone viewport. That width is the point: it is a desktop
 * window somebody narrowed, and the board has to survive it.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);

const port = Number(process.env.TESSERA_E2E_PORT ?? 34216);
const origin = `http://127.0.0.1:${port}`;
const headless = process.env.TESSERA_E2E_HEADED !== '1';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-phone-viewport-e2e');

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-phone-data-'));
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-phone-fixture-'));
const projectName = `phone-e2e-${path.basename(fixtureDir).slice(-6)}`;
const projectDir = path.join(fixtureDir, projectName);

const PHONE = { width: 360, height: 880 };
const NARROW_DESKTOP = { width: 1000, height: 900 };
const VIEW_MODE_KEY = 'ccw:viewMode';

const serverOutput = [];
let server = null;
let browser = null;
let page = null;
let appSecret = null;
const results = [];

function logs() {
  return serverOutput.join('');
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

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      if ((await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      })).ok) return;
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

async function api(pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      // Writes are same-origin only, so a bare fetch is turned away.
      origin,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

// ------------------------------------------------------------------- ui ---

/**
 * A page at one viewport, arriving with the board already stored as the view
 * mode — which is the state the whole ticket is about.
 */
async function openApp(viewport, { touch }) {
  if (page) await page.context().close();
  const context = await browser.newContext({
    viewport,
    hasTouch: touch,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addInitScript(
    ([viewModeKey, dir]) => {
      localStorage.setItem(viewModeKey, 'board');
      localStorage.setItem('ccw:projectViewModes', JSON.stringify({ [dir]: 'board' }));
      localStorage.setItem('ccw:selectedProjectDir', dir);
    },
    [VIEW_MODE_KEY, projectDir],
  );
  page = await context.newPage();
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 120_000 });
  await expandLeftPanel();
  return page;
}

/**
 * Below 1024px the left panel arrives collapsed, so the list or board is not on
 * screen until it is opened — which is what a user does to reach either.
 */
async function expandLeftPanel() {
  const toggle = page.getByTestId('tab-bar-sidebar-toggle');
  if (await toggle.count() > 0) await toggle.click();
  await page.locator('[data-testid="sidebar"], [data-testid="kanban-board"]')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 });
}

async function setKanbanSessionOpenMode(mode) {
  const response = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ kanbanSessionOpenMode: mode }),
  });
  assert.equal(response.ok, true, `could not set the kanban open mode: ${response.text}`);
}

const storedViewMode = () => page.evaluate((key) => localStorage.getItem(key), VIEW_MODE_KEY);

/** Every box of the new-tab screen's mode grid, in document order. */
function modeButtons() {
  return page.evaluate(() => ['chat', 'task', 'shell']
    .map((mode) => document.querySelector(`[data-testid="empty-panel-mode-${mode}"]`))
    .filter(Boolean)
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width) };
    }));
}

// --------------------------------------------------------------- phases ---

async function phaseThePhoneShowsTheListAndNeverTheBoard() {
  await openApp(PHONE, { touch: true });

  assert.equal(
    await page.getByTestId('kanban-board').count(),
    0,
    'the board must be absent from the tree at 360px, not merely hidden',
  );
  assert.equal(
    await page.getByTestId('sidebar').count(),
    1,
    'and the list is what stands in its place',
  );
  assert.equal(
    await page.getByTestId('view-mode-toggle').count(),
    0,
    'the toggle is gone too — it would lead somewhere unreachable',
  );
  // The board's peek layout replaces the tab workspace with the board across
  // the whole window. A phone that is showing the list must keep its workspace.
  assert.equal(
    await page.getByTestId('tab-bar').count(),
    1,
    'the tab workspace survives a stored board, kanban open mode being peek',
  );
}

async function phaseThePhoneVisitLeavesTheStoredBoardAlone() {
  // Still on the phone page from the phase above: what the desktop shows later
  // is decided by this value, and a phone visit may not touch it.
  assert.equal(
    await storedViewMode(),
    'board',
    'a phone visit must not rewrite the stored view mode',
  );

  // Sitting on the page for a moment covers a deferred write as well as an
  // immediate one — the damage this guards against lands later, elsewhere.
  await page.waitForTimeout(1_500);
  assert.equal(await storedViewMode(), 'board', 'and still not after the page settles');
}

async function phaseTheModeGridStacksOnAPhone() {
  // How many modes are offered depends on what the project supports, so the
  // count is read rather than assumed; what matters is how they are laid out.
  const boxes = await modeButtons();
  assert.ok(boxes.length >= 2, `the new-tab screen offers modes to lay out: ${boxes.length}`);

  const columns = new Set(boxes.map((box) => box.left));
  assert.equal(columns.size, 1, `the modes stack into one column at 360px: ${JSON.stringify(boxes)}`);
  assert.ok(
    boxes.every((box) => box.width > 200),
    `each mode gets the width to read its hint: ${JSON.stringify(boxes)}`,
  );

  const scrolls = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(
    scrolls.scrollWidth <= scrolls.clientWidth,
    `the new-tab screen must not push the page sideways: ${JSON.stringify(scrolls)}`,
  );
}

async function phaseANarrowedDesktopKeepsItsBoard() {
  // Split, so the board shares the window with the tab workspace. Peek gives
  // the board a zero-width column at this width, which is its own defect and
  // not this ticket's — it happens with or without these changes.
  await setKanbanSessionOpenMode('split');
  await openApp(NARROW_DESKTOP, { touch: false });

  assert.equal(
    await page.getByTestId('kanban-board').count(),
    1,
    'at 1000px the board still renders — 1000px is a narrowed desktop window, not a phone',
  );
  assert.equal(
    await page.getByTestId('view-mode-toggle').count(),
    1,
    'and the toggle is still there to leave it with',
  );
  assert.equal(await storedViewMode(), 'board', 'the stored view mode is what put it there');
}

async function phaseTheModeGridIsUntouchedOnADesktop() {
  // The board is showing, so the new-tab screen is reached through its panel.
  await page.getByTestId('view-mode-list').click();
  await page.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 30_000 });

  const boxes = await modeButtons();
  assert.ok(boxes.length >= 2, `the same modes as the phone saw: ${boxes.length}`);
  const rows = new Set(boxes.map((box) => box.top));
  assert.equal(rows.size, 1, `they stay on one row above the breakpoint: ${JSON.stringify(boxes)}`);
  assert.equal(
    new Set(boxes.map((box) => box.left)).size,
    boxes.length,
    `side by side, as before this ticket: ${JSON.stringify(boxes)}`,
  );
}

// ---------------------------------------------------------------- main ---

const phases = [
  ['the phone shows the list and never the board', phaseThePhoneShowsTheListAndNeverTheBoard],
  ['the phone visit leaves the stored board alone', phaseThePhoneVisitLeavesTheStoredBoardAlone],
  ['the mode grid stacks on a phone', phaseTheModeGridStacksOnAPhone],
  ['a narrowed desktop keeps its board', phaseANarrowedDesktopKeepsItsBoard],
  ['the mode grid is untouched on a desktop', phaseTheModeGridIsUntouchedOnADesktop],
];

let failure = null;
try {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', 'init', '-b', 'main'], {
    cwd: projectDir,
  });

  await startServer();
  // The fixture lives on the Linux filesystem, which a native-mode server
  // refuses to register.
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);
  const registered = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });
  assert.equal(registered.ok, true, `could not register the project: ${registered.text}`);

  browser = await chromium.launch({ headless });

  for (const [name, phase] of phases) {
    try {
      await phase();
      results.push(`ok   ${name}`);
      console.log(`ok   ${name}`);
    } catch (error) {
      results.push(`FAIL ${name}: ${error.message}`);
      console.error(`FAIL ${name}`);
      throw error;
    }
  }
} catch (error) {
  failure = error;
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(artifactDir, 'failure.html'), await page.content().catch(() => ''), 'utf8')
      .catch(() => {});
  }
  console.error(logs().slice(-4000));
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${results.join('\n')}`);
if (failure) process.exit(1);
