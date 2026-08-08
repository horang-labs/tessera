/**
 * Full-screen overlay panels step aside once they have opened something (#258).
 *
 * At the Phone viewport the sidebar and the Git panel are both `fixed inset-0`.
 * Whatever they open therefore opens *behind* them: QA measured the tab list
 * trigger already carrying the session's title, and the file's name, while the
 * screen still showed the list it was tapped in. That illusion is convincing
 * enough that it produced #260, a ticket filed against a feature that worked.
 *
 * The two faces are one defect, so they are one file. What is measured is what a
 * finger reaches and an eye sees — the box of each panel, and who owns the pixel
 * at the middle of the screen — never a class name:
 *
 *   1. Phone, sidebar: the overlay covers the content area, a tap on a session
 *      row opens it, and the overlay is gone with no further interaction.
 *   2. Phone, collection `+`: creating a session lands on the session.
 *   3. Phone, Git panel: tapping a file in the Files tab lands on its viewer.
 *   4. Phone: taps that are not selections — the All/Running filter, a
 *      collection header, a folder in the file tree — leave the panel open.
 *   5. Phone: re-opening either panel is one tap on the control in the tab bar.
 *   6. Compact viewport (800px): unchanged. Both panels are overlays at this
 *      width too, and the ticket's rule stops below 640px, so the sidebar and
 *      the Git panel must still be there after the same taps.
 *   7. Desktop (1280px): unchanged, where both are columns beside the content.
 *   8. Phase 1's verdict at the largest font scale. The rule is not
 *      `rem`-shaped, so this is a guard rather than the point — the default
 *      scale is where a layout carries slack, and the wave has been bitten by
 *      only testing it.
 *
 * The server runs from the repository itself rather than a copied app root, so
 * Tailwind's utility layer exists and every box measured is a styled box (#252).
 *
 * What this file cannot settle: whether the collapse reads as a deliberate
 * transition or as the panel vanishing. Playwright asserts the end state and
 * never sees the motion. That is on the issue as a device step.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1,3 while iterating.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';

const run = promisify(execFile);

/**
 * A Compact viewport that is not a Phone viewport. Both panels are `fixed
 * inset-0` overlays here as well, which is exactly why it is measured: the
 * ticket's rule hangs off the 640px step and not off the overlay.
 */
const COMPACT_VIEWPORT = { width: 800, height: 900 };

/** A pointer-driven window, where both panels are columns and nothing is covered. */
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/** The largest of `FONT_SCALE_OPTIONS`. */
const LARGEST_FONT_SCALE = 1.375;

/** The file tapped in the Files tab, and the folder expanded without opening anything. */
const TARGET_FILE = 'Dockerfile';
const TARGET_FOLDER = 'src';

const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-phone-overlay-e2e');
const selectedPhases = process.env.TESSERA_E2E_PHASES
  ? new Set(process.env.TESSERA_E2E_PHASES.split(',').map((value) => value.trim()))
  : null;

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-phone-overlay-data-'));
const fixtureDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-phone-overlay-fixture-'));
const projectDir = path.join(fixtureDir, 'overlay-e2e');

const serverOutput = [];
let server = null;
let browser = null;
let page = null;
let appSecret = null;
const sessionTitles = ['Overlay first session', 'Overlay second session'];
const sessionIds = [];
const results = [];
const measurements = [];

const logs = () => serverOutput.join('');

/**
 * The account the browser's cookie names. A cookie rather than the app-secret
 * header because `extraHTTPHeaders` never reaches a WebSocket upgrade, and the
 * quick-create sheet's provider list arrives over that socket — without it the
 * sheet's actions stay disabled and phase 2 cannot run at all.
 */
const BROWSER_USER_ID = 'e2e-browser-user';

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

/** Recorded next to each verdict so the report carries numbers, not adjectives. */
function record(label, value) {
  measurements.push(`${label}: ${JSON.stringify(value)}`);
  console.log(`     ${label}: ${JSON.stringify(value)}`);
}

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
      // Without this the browser's WebSocket upgrade is refused and the
      // provider list the quick-create sheet gates on never arrives.
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
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
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not every route answers with JSON.
  }
  return { ok: response.ok, status: response.status, text, json };
}

// ---------------------------------------------------------------- fixture ---

async function buildFixture() {
  await fs.mkdir(path.join(projectDir, TARGET_FOLDER), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, TARGET_FILE),
    'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n',
    'utf8',
  );
  await fs.writeFile(path.join(projectDir, 'README.md'), '# overlay e2e fixture\n', 'utf8');
  await fs.writeFile(path.join(projectDir, TARGET_FOLDER, 'index.ts'), 'export const x = 1;\n', 'utf8');
  await run(
    'git',
    ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', 'init', '-b', 'main'],
    { cwd: projectDir },
  );
}

async function registerProject() {
  // The fixture lives on the Linux filesystem, which a native-mode server refuses.
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
}

/** Chat sessions, so the sidebar has rows to tap. No CLI is ever spawned. */
async function createSessions() {
  for (const title of sessionTitles) {
    const response = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        workDir: projectDir,
        parentProjectId: projectDir,
        providerId: 'claude-code',
        executionMode: 'gui',
        title,
        hasCustomTitle: true,
      }),
    });
    assert.equal(response.ok, true, `could not create a session: ${response.text}`);
    const id = response.json?.sessionId ?? response.json?.session?.id ?? response.json?.id;
    assert.ok(id, `the session response carried no id: ${response.text}`);
    sessionIds.push(id);
  }
}

/**
 * The font scale lives on the server and `ThemeInitializer` writes `--font-scale`
 * from the loaded settings, so seeding localStorage alone is overwritten on
 * hydration. Both are set; see `openApp`.
 */
async function setFontScale(scale) {
  const response = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ fontSize: scale }),
  });
  assert.equal(response.ok, true, `could not set the font scale: ${response.text}`);
}

// --------------------------------------------------------------------- ui ---

/**
 * A page at one viewport, arriving with the project selected and the Git panel
 * closed on the tab the phase needs. Every phase starts from a fresh context so
 * one phase's persisted panel state cannot decide the next one's verdict.
 */
async function openApp({ viewport, touch, fontScale = 1, gitPanelTab = 'git' }) {
  if (page) await page.context().close().catch(() => {});
  await setFontScale(fontScale);

  const options = { extraHTTPHeaders: { 'x-tessera-app-secret': appSecret } };
  const context = viewport === PHONE_VIEWPORT
    ? await createPhoneContext(browser, options)
    : await browser.newContext({ ...options, viewport, hasTouch: touch });

  await context.addInitScript(
    ([dir, scale, panelTab]) => {
      localStorage.setItem('ccw:selectedProjectDir', dir);
      localStorage.setItem('tessera:settings', JSON.stringify({
        state: { settings: { fontSize: scale, theme: 'light' } },
        version: 0,
      }));
      localStorage.setItem('tessera:git-panel', JSON.stringify({
        state: { isOpen: false, panelWidth: 320, drawerHeight: 320, panelTab },
        version: 0,
      }));
    },
    [projectDir, fontScale, gitPanelTab],
  );

  await context.addCookies([
    { name: 'jwt', value: await mintBrowserToken(), domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));
  // 'load' rather than 'domcontentloaded': every box measured here is a styled
  // box, and an unstyled panel measures as its content.
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 120_000 });

  // This test authenticates HTTP with the app-secret header, which a browser
  // cannot attach to a WebSocket upgrade. Keep the expected dev-only overlay
  // off the controls being tapped.
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
  await page.waitForTimeout(300);
  return page;
}

/**
 * The project's own group. The list also carries a Recent work group that
 * repeats the same rows, so every row is addressed inside one group or the
 * locator matches twice.
 */
const GROUP = '[data-testid="collection-group-__uncategorized"]';

const sessionRow = (id) => page.locator(`${GROUP} [data-testid="collection-chat-${id}"]`);

/** Below 1024px the left panel arrives collapsed, so a user opens it to see the list. */
async function expandSidebar() {
  const toggle = page.getByTestId('tab-bar-sidebar-toggle');
  if (await toggle.count() > 0) await toggle.click();
  await page.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 30_000 });
  await sessionRow(sessionIds[0]).waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Tap a session row and wait until the tab bar names it. The Git panel reads
 * its files from the active session, so opening it before this has settled
 * measures an empty tree rather than the panel.
 */
async function openSessionFromSidebar(index) {
  await sessionRow(sessionIds[index]).tap();
  await page.waitForFunction(
    (title) => document.querySelector('[data-testid="tab-list-trigger"]')?.textContent?.includes(title),
    sessionTitles[index],
    { timeout: 30_000 },
  );
}

/**
 * The Git panel's control lives in the tab bar, which the open sidebar covers.
 * Above the Phone viewport step selecting a session leaves the sidebar where it
 * was — by design — so getting to the Git panel there means closing it first.
 */
async function collapseSidebarIfStillOpen() {
  if (await page.getByTestId('sidebar').count() === 0) return;
  await page.evaluate(() => {
    document.querySelector('[data-testid="sidebar-collapse-btn"]')?.click();
  });
  await page.getByTestId('sidebar').waitFor({ state: 'detached', timeout: 30_000 });
}

async function openGitPanel() {
  await page.getByTestId('tab-bar-git-toggle').click();
  await page.getByTestId('git-panel').waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Open the Git panel with its Files tab actually listing the workspace.
 *
 * The panel reads its files from whichever session is active, and that
 * resolution can still be settling when the panel mounts — it then renders "no
 * readable files" and never asks again, because nothing about the tree changed.
 * A user would tap the control twice; so does this, once, rather than measure an
 * empty panel. Unrelated to the ticket: it happens with and without the fix.
 */
async function openGitPanelWithFiles() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await openGitPanel();
    const listed = await page
      .locator('[data-testid^="workspace-file-row-"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true, () => false);
    if (listed) return;
    await page.getByTestId('tab-bar-git-toggle').click();
    await page.getByTestId('git-panel').waitFor({ state: 'detached', timeout: 30_000 });
  }
  throw new Error('the Files tab never listed the workspace');
}

/**
 * Everything the ticket argues about, in one reading: the box of each overlay,
 * who owns the pixel at the middle of the screen, and what the tab bar says is
 * open. The centre pixel is the assertion that matches the complaint — the
 * session or file is open, and something else is painted over it.
 */
function measure() {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const box = (element) => {
      if (!element) return null;
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
    const owner = (element) => {
      if (!element) return 'none';
      if (element.closest('[data-testid="git-panel"]')) return 'git-panel';
      if (element.closest('[data-testid="left-panel-container"]')) return 'left-panel';
      if (element.closest('[data-testid="tab-panel-host"]')) return 'tab-panel-host';
      if (element.closest('[data-testid="tab-bar"]')) return 'tab-bar';
      return element.tagName.toLowerCase();
    };

    const centre = {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
    };
    const tabItems = [...document.querySelectorAll('[data-testid="tab-item"]')]
      .map((element) => element.textContent?.trim() ?? '');

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      sidebarPresent: Boolean(document.querySelector('[data-testid="sidebar"]')),
      gitPanelPresent: Boolean(document.querySelector('[data-testid="git-panel"]')),
      sidebar: box(document.querySelector('[data-testid="left-panel-container"]')),
      gitPanel: box(document.querySelector('[data-testid="git-panel"]')),
      centre: { ...centre, owner: owner(document.elementFromPoint(centre.x, centre.y)) },
      // The phone's tab bar shows one trigger naming the active tab (#247); a
      // desktop shows the strip, so both are read and each phase uses its own.
      tabLabel: document.querySelector('[data-testid="tab-list-trigger"]')?.textContent?.trim() ?? null,
      tabItems,
      sidebarToggleCount: document.querySelectorAll('[data-testid="tab-bar-sidebar-toggle"]').length,
      gitToggleCount: document.querySelectorAll('[data-testid="tab-bar-git-toggle"]').length,
    };
  });
}

const shot = (name) => page.screenshot({ path: path.join(artifactDir, `${name}.png`) }).catch(() => {});

// ------------------------------------------------------------------ phases ---

async function phaseTheSidebarStepsAsideForTheSessionItOpens() {
  await openApp({ viewport: PHONE_VIEWPORT, touch: true });
  await expandSidebar();

  const covered = await measure();
  record('1 sidebar overlay, before the tap', {
    viewport: covered.viewport,
    sidebar: covered.sidebar,
    centreOwner: covered.centre.owner,
  });
  // The premise the ticket measured: the panel is over the content area, so
  // whatever it opens opens behind it.
  assert.equal(covered.sidebarPresent, true, 'the sidebar is open before the tap');
  assert.equal(
    covered.centre.owner,
    'left-panel',
    `the sidebar owns the middle of the screen before the tap: ${JSON.stringify(covered.centre)}`,
  );
  assert.ok(
    covered.sidebar.right >= covered.viewport.width,
    `and reaches the right edge: ${JSON.stringify(covered.sidebar)}`,
  );
  await shot('phase1-sidebar-open');

  await sessionRow(sessionIds[1]).tap();
  await page.waitForTimeout(600);

  const after = await measure();
  record('1 after tapping a session row', {
    sidebarPresent: after.sidebarPresent,
    centreOwner: after.centre.owner,
    tabLabel: after.tabLabel,
  });
  await shot('phase1-after-session-tap');

  // Already established by the ticket, kept as the control: the tap works.
  assert.equal(
    after.tabLabel,
    sessionTitles[1],
    `the tab bar switched to the session that was tapped: ${JSON.stringify(after)}`,
  );
  assert.equal(
    after.sidebarPresent,
    false,
    'the sidebar stepped aside with no further interaction',
  );
  assert.equal(
    after.centre.owner,
    'tab-panel-host',
    `and the session is what the middle of the screen shows: ${JSON.stringify(after.centre)}`,
  );
}

async function phaseCreatingFromTheCollectionPlusLandsOnTheSession() {
  await openApp({ viewport: PHONE_VIEWPORT, touch: true });
  await expandSidebar();

  await page.locator(`${GROUP} [data-testid^="collection-quick-create-toggle-"]`).first().tap();
  const createChat = page.locator('[data-testid^="collection-quick-create-chat-"]').first();
  await createChat.waitFor({ state: 'visible', timeout: 30_000 });
  // The sheet enables its actions once a provider is resolved; a run where no
  // CLI is installed cannot exercise this face and must say so rather than pass.
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid^="collection-quick-create-chat-"]');
    return Boolean(button) && !button.disabled;
  }, undefined, { timeout: 30_000 });

  const before = await measure();
  assert.equal(before.sidebarPresent, true, 'the sidebar is open while the sheet is filled in');

  await createChat.tap();
  await page.waitForFunction(
    (known) => {
      const rows = [...document.querySelectorAll(
        '[data-testid="collection-group-__uncategorized"] [data-testid^="collection-chat-"]',
      )];
      return rows.length > known;
    },
    sessionIds.length,
    { timeout: 60_000 },
  ).catch(() => {});
  await page.waitForTimeout(1_200);

  const after = await measure();
  record('2 after creating from the collection +', {
    sidebarPresent: after.sidebarPresent,
    centreOwner: after.centre.owner,
    tabLabel: after.tabLabel,
  });
  await shot('phase2-after-create');

  assert.equal(
    after.sidebarPresent,
    false,
    'creating a session steps the sidebar aside — three taps to reach what you just made is the worst case in the report',
  );
  assert.equal(
    after.centre.owner,
    'tab-panel-host',
    `and the new session is what the middle of the screen shows: ${JSON.stringify(after.centre)}`,
  );
}

async function phaseTheGitPanelStepsAsideForTheFileItOpens() {
  await openApp({ viewport: PHONE_VIEWPORT, touch: true, gitPanelTab: 'files' });
  await expandSidebar();
  await openSessionFromSidebar(0);
  await collapseSidebarIfStillOpen();
  await openGitPanelWithFiles();
  const fileRow = page.locator(`[data-testid="workspace-file-row-${TARGET_FILE}"]`);
  await fileRow.waitFor({ state: 'visible', timeout: 30_000 });

  const covered = await measure();
  record('3 git panel overlay, before the tap', {
    viewport: covered.viewport,
    gitPanel: covered.gitPanel,
    centreOwner: covered.centre.owner,
  });
  assert.deepEqual(
    { left: covered.gitPanel.left, top: covered.gitPanel.top },
    { left: 0, top: 0 },
    `the Git panel is pinned to the corner of the screen: ${JSON.stringify(covered.gitPanel)}`,
  );
  assert.equal(
    covered.centre.owner,
    'git-panel',
    `and owns the middle of the screen before the tap: ${JSON.stringify(covered.centre)}`,
  );
  await shot('phase3-git-panel-open');

  await fileRow.tap();
  await page.waitForTimeout(800);

  const after = await measure();
  record('3 after tapping a file in the Files tab', {
    gitPanelPresent: after.gitPanelPresent,
    centreOwner: after.centre.owner,
    tabLabel: after.tabLabel,
  });
  await shot('phase3-after-file-tap');

  // The reading that closed #260 as unreproducible, kept as the control.
  assert.equal(
    after.tabLabel,
    TARGET_FILE,
    `the tab bar switched to the file that was tapped: ${JSON.stringify(after)}`,
  );
  assert.equal(
    after.gitPanelPresent,
    false,
    'the Git panel stepped aside with no further interaction',
  );
  assert.equal(
    after.centre.owner,
    'tab-panel-host',
    `and the file's viewer is what the middle of the screen shows: ${JSON.stringify(after.centre)}`,
  );
}

async function phaseTapsThatAreNotSelectionsLeaveThePanelOpen() {
  await openApp({ viewport: PHONE_VIEWPORT, touch: true, gitPanelTab: 'files' });
  await expandSidebar();

  await page.getByTestId('sidebar-running-filter').tap();
  await page.waitForTimeout(300);
  assert.equal(
    (await measure()).sidebarPresent,
    true,
    'switching the All/Running filter is not a selection and leaves the sidebar open',
  );

  await page.getByTestId('sidebar-all-filter').tap();
  await page.waitForTimeout(300);
  await page.locator(`${GROUP} [data-testid^="collection-header-"]`).first().tap();
  await page.waitForTimeout(300);
  assert.equal(
    (await measure()).sidebarPresent,
    true,
    'collapsing a collection is not a selection either',
  );
  // Put the group back — the rows this phase still needs live inside it.
  await page.locator(`${GROUP} [data-testid^="collection-header-"]`).first().tap();
  await page.waitForTimeout(300);

  // Now the same rule inside the Git panel's file tree.
  await openSessionFromSidebar(0);
  await collapseSidebarIfStillOpen();
  await openGitPanelWithFiles();
  const folder = page.locator(`[data-testid="git-panel"] button[title="${TARGET_FOLDER}"]`).first();
  await folder.waitFor({ state: 'visible', timeout: 60_000 });
  await folder.tap();
  await page.waitForTimeout(400);

  const after = await measure();
  record('4 after expanding a folder', {
    gitPanelPresent: after.gitPanelPresent,
    centreOwner: after.centre.owner,
  });
  assert.equal(
    after.gitPanelPresent,
    true,
    'expanding a folder opens nothing, so the Git panel stays where it is',
  );
  assert.equal(
    await page.locator(`[data-testid="workspace-file-row-${TARGET_FOLDER}/index.ts"]`).count(),
    1,
    'and the folder did expand — the tap was not simply lost',
  );
}

async function phaseReopeningEitherPanelIsOneTap() {
  await openApp({ viewport: PHONE_VIEWPORT, touch: true, gitPanelTab: 'files' });
  await expandSidebar();
  await sessionRow(sessionIds[1]).tap();
  await page.waitForTimeout(600);

  const collapsed = await measure();
  assert.equal(collapsed.sidebarToggleCount, 1, 'the sidebar control is in the tab bar');
  await page.getByTestId('tab-bar-sidebar-toggle').tap();
  await page.waitForTimeout(400);
  assert.equal(
    (await measure()).sidebarPresent,
    true,
    'one tap on the control already in the tab bar brings the sidebar back',
  );

  // Back out of the sidebar the same way, then the Git panel's half.
  await openSessionFromSidebar(0);
  await openGitPanelWithFiles();
  await page.locator(`[data-testid="workspace-file-row-${TARGET_FILE}"]`).tap();
  await page.waitForTimeout(800);

  const closed = await measure();
  assert.equal(closed.gitToggleCount, 1, 'the Git control is in the tab bar');
  await page.getByTestId('tab-bar-git-toggle').tap();
  await page.waitForTimeout(500);
  const reopened = await measure();
  record('5 re-opening', {
    sidebarToggleCount: collapsed.sidebarToggleCount,
    gitToggleCount: closed.gitToggleCount,
    gitPanelPresent: reopened.gitPanelPresent,
  });
  assert.equal(
    reopened.gitPanelPresent,
    true,
    'and one tap brings the Git panel back too',
  );
}

/**
 * A Compact viewport is a desktop window somebody narrowed. Both panels are
 * overlays here as well, so this is the phase that catches a fix hung off the
 * overlay instead of off the Phone viewport step.
 */
async function phaseACompactViewportIsUnchanged() {
  await openApp({ viewport: COMPACT_VIEWPORT, touch: false, gitPanelTab: 'files' });
  await expandSidebar();

  await sessionRow(sessionIds[1]).click();
  await page.waitForTimeout(600);
  const afterSession = await measure();
  record('6 compact, after selecting a session', {
    viewport: afterSession.viewport,
    sidebarPresent: afterSession.sidebarPresent,
    sidebar: afterSession.sidebar,
  });
  assert.equal(
    afterSession.sidebarPresent,
    true,
    'at 800px the sidebar keeps the behaviour it had before this ticket',
  );

  await collapseSidebarIfStillOpen();
  await openGitPanelWithFiles();
  const fileRow = page.locator(`[data-testid="workspace-file-row-${TARGET_FILE}"]`);
  await fileRow.click();
  await page.waitForTimeout(800);

  const afterFile = await measure();
  record('6 compact, after opening a file', {
    gitPanelPresent: afterFile.gitPanelPresent,
    gitPanel: afterFile.gitPanel,
  });
  assert.equal(
    afterFile.gitPanelPresent,
    true,
    'and so does the Git panel',
  );
}

async function phaseADesktopIsUnchanged() {
  await openApp({ viewport: DESKTOP_VIEWPORT, touch: false, gitPanelTab: 'files' });
  await page.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 30_000 });
  await sessionRow(sessionIds[0]).waitFor({ state: 'visible', timeout: 30_000 });

  const before = await measure();
  await sessionRow(sessionIds[1]).click();
  await page.waitForTimeout(600);
  const afterSession = await measure();
  record('7 desktop, sidebar box before/after selecting a session', {
    before: before.sidebar,
    after: afterSession.sidebar,
  });
  assert.equal(afterSession.sidebarPresent, true, 'the sidebar is a column and stays one');
  assert.deepEqual(
    afterSession.sidebar,
    before.sidebar,
    'and does not move a pixel when a session is selected',
  );

  await openGitPanelWithFiles();
  const fileRow = page.locator(`[data-testid="workspace-file-row-${TARGET_FILE}"]`);
  const gitBefore = await measure();
  await fileRow.click();
  await page.waitForTimeout(800);
  const gitAfter = await measure();
  record('7 desktop, git panel box before/after opening a file', {
    before: gitBefore.gitPanel,
    after: gitAfter.gitPanel,
  });
  await shot('phase7-desktop-after-file');

  assert.equal(gitAfter.gitPanelPresent, true, 'the Git panel is a column and stays one');
  assert.deepEqual(
    gitAfter.gitPanel,
    gitBefore.gitPanel,
    'and does not move a pixel when a file is opened',
  );
  assert.ok(
    gitAfter.tabItems.some((label) => label.includes(TARGET_FILE)),
    `the file did open into a tab here too: ${JSON.stringify(gitAfter.tabItems)}`,
  );
}

async function phaseTheLargestFontScaleAgrees() {
  await openApp({ viewport: PHONE_VIEWPORT, touch: true, fontScale: LARGEST_FONT_SCALE });
  const rootFontSize = await page.evaluate(
    () => getComputedStyle(document.documentElement).fontSize,
  );
  record('8 root font size at the largest scale', rootFontSize);
  assert.equal(rootFontSize, '22px', 'the largest font scale is actually in effect');

  await expandSidebar();
  await sessionRow(sessionIds[1]).tap();
  await page.waitForTimeout(600);

  const after = await measure();
  record('8 after tapping a session row at the largest scale', {
    sidebarPresent: after.sidebarPresent,
    centreOwner: after.centre.owner,
  });
  await shot('phase8-largest-font-scale');
  assert.equal(after.sidebarPresent, false, 'the rule does not depend on the font scale');
  assert.equal(after.centre.owner, 'tab-panel-host', JSON.stringify(after.centre));
}

// -------------------------------------------------------------------- main ---

const phases = [
  ['1 the sidebar steps aside for the session it opens', phaseTheSidebarStepsAsideForTheSessionItOpens],
  ['2 creating from the collection + lands on the session', phaseCreatingFromTheCollectionPlusLandsOnTheSession],
  ['3 the git panel steps aside for the file it opens', phaseTheGitPanelStepsAsideForTheFileItOpens],
  ['4 taps that are not selections leave the panel open', phaseTapsThatAreNotSelectionsLeaveThePanelOpen],
  ['5 re-opening either panel is one tap', phaseReopeningEitherPanelIsOneTap],
  ['6 a compact viewport is unchanged', phaseACompactViewportIsUnchanged],
  ['7 a desktop is unchanged', phaseADesktopIsUnchanged],
  ['8 the largest font scale agrees', phaseTheLargestFontScaleAgrees],
];

let failure = null;
try {
  await fs.mkdir(artifactDir, { recursive: true });
  await buildFixture();
  await writeBrowserUser();
  await startServer();
  await registerProject();
  await createSessions();
  browser = await launchPhoneBrowser();

  for (const [name, phase] of phases) {
    if (selectedPhases && !selectedPhases.has(name.split(' ')[0])) continue;
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
    await page.screenshot({ path: path.join(artifactDir, 'failure.png') }).catch(() => {});
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

console.log(`\n${measurements.join('\n')}`);
console.log(`\n${results.join('\n')}`);
if (failure) process.exit(1);
