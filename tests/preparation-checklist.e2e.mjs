/**
 * End-to-end coverage for the ignored-file checklist (issue #198).
 *
 * A real server, a real browser and a real git repository, all in throwaway
 * directories. The checklist is driven from the settings panel exactly as a
 * user would drive it, and what it wrote is read back through the API.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);

const port = Number(process.env.TESSERA_E2E_PORT ?? 34214);
const origin = `http://127.0.0.1:${port}`;
const headless = process.env.TESSERA_E2E_HEADED !== '1';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-checklist-e2e');

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-checklist-data-'));
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-checklist-fixture-'));
const projectName = `checklist-e2e-${path.basename(fixtureDir).slice(-6)}`;
const projectDir = path.join(fixtureDir, projectName);

const OPEN_MARKER = '# >>> tessera: files copied into each worktree >>>';
const CLOSE_MARKER = '# <<< tessera <<<';
const NOTICE = '# Rewritten from the checklist. Move a line out of this block to keep your own version.';

const serverOutput = [];
let server = null;
let browser = null;
let page = null;
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
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
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
      if ((await fetch(`${origin}/api/settings`)).ok) return;
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
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
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

async function readStoredScript() {
  const response = await api(
    `/api/projects/preparation-script?projectId=${encodeURIComponent(projectDir)}`,
  );
  assert.equal(response.ok, true, `could not read the script: ${response.text}`);
  return response.json.preparationScript ?? '';
}

async function setStoredScript(script) {
  const response = await api('/api/projects/preparation-script', {
    method: 'PUT',
    body: JSON.stringify({ projectId: projectDir, preparationScript: script }),
  });
  assert.equal(response.ok, true, `could not save the script: ${response.text}`);
}

/** The editor debounces, so a save lands a moment after the last keystroke. */
async function waitForStoredScript(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readStoredScript();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}\nstored script was:\n${last}`);
}

// -------------------------------------------------------------------- ui ---

function tickFor(candidatePath) {
  return page.getByTestId(`ignored-file-tick-${candidatePath}`);
}

async function openSettingsProjectSection() {
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });

  // The server registers its own working directory as a project and sorts it
  // first, so the fixture has to be selected before the panel is opened.
  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click({ timeout: 30_000 });
  await page.getByTestId('settings-nav-project').click({ timeout: 30_000 });
  await page.getByTestId('project-preparation-script').waitFor({ state: 'visible', timeout: 30_000 });
}

/**
 * Have the list on screen.
 *
 * The checklist is expanded from the start, so usually there is nothing to
 * click and what takes time is the scan — which itself waits for the editor to
 * have read the script. Only a checklist somebody collapsed needs the click.
 */
async function expandChecklist() {
  if (await page.getByTestId('ignored-file-checklist-body').count() === 0) {
    await page.getByTestId('ignored-file-checklist-toggle').click();
  }
  await page.getByTestId('ignored-file-checklist-list').waitFor({ state: 'visible', timeout: 60_000 });
}

async function collapseChecklist() {
  await page.getByTestId('ignored-file-checklist-toggle').click();
  await page.getByTestId('ignored-file-checklist-body').waitFor({ state: 'hidden', timeout: 10_000 });
}

/** Every candidate the checklist is showing, in the order it shows them. */
async function listedPaths({ tickedOnly = false } = {}) {
  return page.evaluate((onlyTicked) => {
    const boxes = document.querySelectorAll('[data-testid^="ignored-file-tick-"]');
    return [...boxes]
      .filter((box) => !onlyTicked || box.checked)
      .map((box) => box.getAttribute('data-testid').replace('ignored-file-tick-', ''));
  }, tickedOnly);
}

const tickedPaths = () => listedPaths({ tickedOnly: true });

// ------------------------------------------------------------- fixtures ---

async function write(relativePath, contents) {
  const target = path.join(projectDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

async function buildFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  const git = (args) => run(
    'git',
    ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args],
    { cwd: projectDir },
  );
  await git(['init', '-b', 'main']);

  await write('.gitignore', ['.env.local', '.claude/', 'node_modules/', 'dist/', '*.log'].join('\n') + '\n');
  await write('README.md', '# checklist e2e\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial']);

  await write('.env.local', 'LOCAL=1\n');
  await write('.claude/settings.json', '{}\n');
  await write('node_modules/dep/index.js', 'module.exports = 1;\n');
  await write('dist/bundle.js', 'console.log(1);\n');
  await write('debug.log', 'noise\n');
}

// --------------------------------------------------------------- phases ---

async function phaseAnEmptyScriptGetsTheDefaults() {
  await openSettingsProjectSection();
  await expandChecklist();

  assert.deepEqual(
    [...(await listedPaths())].sort(),
    ['.claude', '.env.local', 'debug.log', 'dist', 'node_modules'],
    'the collapsed scan lists every ignored entry exactly once',
  );
  assert.deepEqual(
    (await tickedPaths()).sort(),
    ['.claude', '.env.local'],
    'configuration and instructions arrive ticked, the heavy entries do not',
  );

  // Nothing to confirm: a script with nothing in it is filled from the list.
  const stored = await waitForStoredScript(
    (script) => script.includes(OPEN_MARKER) && script.includes(CLOSE_MARKER),
    'an empty script never got the defaults',
  );

  assert.ok(stored.trimEnd().endsWith(CLOSE_MARKER), 'nothing follows the block');
  assert.ok(stored.includes('cp "$TESSERA_PROJECT_DIR/.env.local" .'), 'the file copy is there');
  assert.ok(stored.includes('cp -R "$TESSERA_PROJECT_DIR/.claude" .'), 'the directory copy is recursive');
  assert.ok(!stored.includes('node_modules'), 'nothing unticked was written');

  const shown = await page.getByTestId('project-preparation-script').inputValue();
  assert.equal(shown, stored, 'the editor shows what was stored');

  // The phases below read against a line of the user's own above the block,
  // which is what a script in use actually looks like.
  const editor = page.getByTestId('project-preparation-script');
  await editor.fill(`npm install\n\n${stored}`);
  await editor.blur();
  await waitForStoredScript(
    (script) => script.startsWith('npm install') && script.includes(OPEN_MARKER),
    'the user\'s own line never reached the stored script',
  );
}

/**
 * The list opens by itself, so opening the editor is something a user does
 * while merely looking. A script somebody already wrote must survive that
 * untouched — filling a blank is a beginning, adding to their work is not.
 */
async function phaseAWrittenScriptIsLeftAlone() {
  await setStoredScript('npm run bootstrap');
  await openSettingsProjectSection();
  await expandChecklist();

  assert.deepEqual(
    await tickedPaths(),
    [],
    'with a script that has no block, nothing reads as copied',
  );

  // Long enough that a write would have landed; the script has to be unchanged.
  await page.waitForTimeout(2_000);
  assert.equal(
    await readStoredScript(),
    'npm run bootstrap',
    'looking at the list must not rewrite a script that was already there',
  );

  // And ticking is still what puts the block in, below what they wrote.
  await tickFor('.env.local').check();
  const stored = await waitForStoredScript(
    (script) => script.includes(OPEN_MARKER),
    'a tick never reached the script',
  );
  assert.ok(stored.startsWith('npm run bootstrap'), 'the block goes below what the user typed');
  assert.ok(stored.includes('cp "$TESSERA_PROJECT_DIR/.env.local" .'), 'the tick was written');

  // Left as the next phases expect to find it.
  await setStoredScript(null);
}

async function phaseATickLandsInTheScriptAtOnce() {
  await tickFor('.env.local').uncheck();

  const withoutEnv = await waitForStoredScript(
    (script) => !script.includes('.env.local'),
    'unticking never removed the command',
  );
  assert.ok(withoutEnv.includes('.claude'), 'the other tick stayed where it was');
  assert.ok(withoutEnv.startsWith('npm install'), 'and the user\'s line is still first');

  await tickFor('dist').check();
  const withDist = await waitForStoredScript(
    (script) => script.includes('dist'),
    'ticking never added the command',
  );
  assert.ok(withDist.includes('cp -R "$TESSERA_PROJECT_DIR/dist" .'), 'the new copy is there');

  await tickFor('dist').uncheck();
  await waitForStoredScript(
    (script) => !script.includes('dist'),
    'unticking never took it back out',
  );
}

async function phaseReopeningReadsTheBlockNotTheDefaults() {
  await collapseChecklist();
  await expandChecklist();

  assert.deepEqual(
    (await tickedPaths()).sort(),
    ['.claude'],
    'reopening ticks what the block holds, not what the defaults would',
  );
  // Reopening must not write the defaults back either, or unticking would be
  // undone every time the list is looked at.
  assert.ok(
    !(await readStoredScript()).includes('.env.local'),
    'the unticked default stayed out',
  );
}

async function phaseClearingRemovesTheBlockEntirely() {
  await tickFor('.claude').uncheck();

  const stored = await waitForStoredScript(
    (script) => !script.includes(OPEN_MARKER),
    'the emptied block was left behind',
  );

  assert.ok(!stored.includes(CLOSE_MARKER), 'the closing marker went with it');
  assert.equal(stored, 'npm install', 'only the user\'s own line remains');
}

async function phaseABlockMovedAboveIsRewrittenThere() {
  // Copying has to run before anything that installs from what was copied, and
  // moving the block is how that is arranged. A line moved out of it is the
  // user's own from then on — the gesture the notice inside the block names.
  const moved = [
    OPEN_MARKER,
    NOTICE,
    'cp -R "$TESSERA_PROJECT_DIR/.claude" .',
    CLOSE_MARKER,
    'cp "$TESSERA_PROJECT_DIR/.env.local" .',
    '',
    'npm install',
  ].join('\n');
  await setStoredScript(moved);

  // Reload so the editor picks the moved script up as its starting point.
  await openSettingsProjectSection();
  await expandChecklist();
  assert.deepEqual(
    (await tickedPaths()).sort(),
    ['.claude'],
    'only what is inside the block counts as the checklist\'s doing',
  );

  await tickFor('dist').check();
  const stored = await waitForStoredScript(
    (script) => script.includes('dist'),
    'the new tick never reached the block',
  );

  assert.ok(stored.startsWith(OPEN_MARKER), 'the block stayed where it was moved to');
  assert.ok(
    stored.includes(`${CLOSE_MARKER}\ncp "$TESSERA_PROJECT_DIR/.env.local" .`),
    'the line moved out of the block survived the rewrite',
  );
  assert.ok(stored.includes('npm install'), 'and so did everything else outside it');
}

async function phaseTheChecklistWaitsForTheEditorToLoad() {
  // Hold the load open. Until it lands the editor is showing an empty script,
  // and a tick then would rewrite a script the checklist has never seen —
  // taking with it every line the project already had.
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  let heldRequests = 0;
  await page.route('**/api/projects/preparation-script**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    heldRequests += 1;
    await held;
    // The page may have moved on by the time the hold lifts.
    await route.continue().catch(() => {});
  });

  await setStoredScript('npm run bootstrap');
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });
  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click({ timeout: 30_000 });
  await page.getByTestId('settings-nav-project').click({ timeout: 30_000 });

  // The editor disables itself while a load is in flight; that is the moment
  // the checklist may not offer anything to tick.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="project-preparation-script"]')?.disabled === true,
    null,
    { timeout: 30_000 },
  );
  assert.ok(heldRequests > 0, 'the load was never actually held');
  assert.equal(
    await page.getByTestId('ignored-file-checklist-toggle').isDisabled(),
    true,
    'the checklist cannot be worked while the script is loading',
  );
  // The list is expanded by default, so what has to hold back is the scan: a
  // tick before the script arrives would rewrite a script never seen.
  assert.equal(
    await page.getByTestId('ignored-file-checklist-list').count(),
    0,
    'nothing may be tickable while the script is still loading',
  );

  // Left routed: the hold is lifted for good, so later loads pass straight
  // through, and unrouting here would cancel the request still in flight.
  release();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="ignored-file-checklist-toggle"]')?.disabled,
    null,
    { timeout: 30_000 },
  );

  await expandChecklist();
  // The script that arrived had lines in it, so the scan leaves it alone; what
  // is being checked is that it survived the wait rather than being replaced.
  await page.waitForTimeout(2_000);
  const stored = await readStoredScript();
  assert.equal(stored, 'npm run bootstrap', 'the loaded script was not lost');

  const shown = await page.getByTestId('project-preparation-script').inputValue();
  assert.equal(shown, stored, 'what is on screen is what is stored');
}

// ----------------------------------------------------------------- main ---

const phases = [
  ['an empty script gets the defaults', phaseAnEmptyScriptGetsTheDefaults],
  ['a tick lands in the script at once', phaseATickLandsInTheScriptAtOnce],
  ['reopening reads the block, not the defaults', phaseReopeningReadsTheBlockNotTheDefaults],
  ['clearing removes the block entirely', phaseClearingRemovesTheBlockEntirely],
  ['a block moved above is rewritten there', phaseABlockMovedAboveIsRewrittenThere],
  ['the checklist waits for the editor to load', phaseTheChecklistWaitsForTheEditorToLoad],
  ['a written script is left alone', phaseAWrittenScriptIsLeftAlone],
];

let failure = null;
try {
  await fs.mkdir(artifactDir, { recursive: true });
  await buildFixture();
  await startServer();

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
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

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
  await fs.rm(path.join(os.homedir(), '.tessera', 'worktrees', projectName), { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${results.join('\n')}`);
if (failure) process.exit(1);
