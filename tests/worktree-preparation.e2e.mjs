/**
 * End-to-end coverage for worktree preparation status (issue #201).
 *
 * Everything runs against a real server, a real browser and a real git
 * repository, all inside throwaway directories: the data dir holds the
 * database and the managed worktrees, the fixture dir holds the project.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1,2 while iterating; the
 * default runs all of them in order, because later phases depend on the
 * worktree the first one creates.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);

const port = Number(process.env.TESSERA_E2E_PORT ?? 34211);
const origin = `http://127.0.0.1:${port}`;
const headless = process.env.TESSERA_E2E_HEADED !== '1';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR ?? path.join(os.tmpdir(), 'tessera-preparation-e2e');
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-prep-data-'));
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-prep-fixture-'));
// The project's own name is what the managed worktree root is keyed by, so it
// has to be unique: in WSL mode the root is the user's home, not the data dir.
const projectName = `prep-e2e-${path.basename(fixtureDir).slice(-6)}`;
const projectDir = path.join(fixtureDir, projectName);
const managedWorktreeDir = path.join(os.homedir(), '.tessera', 'worktrees', projectName);

const serverOutput = [];
let server = null;
let browser = null;
let page = null;
const results = [];

// Long enough that the run is still in flight while the badge and the attached
// terminal are being checked.
const SUCCESS_SCRIPT = [
  'echo "preparation-started"',
  'printf ok > prepared.txt',
  'sleep 15',
  'echo "preparation-finished"',
].join('\n');

const FAILING_SCRIPT = [
  'echo "preparation-boom"',
  'exit 3',
].join('\n');

const LONG_SCRIPT = [
  'echo "preparation-long-start"',
  'sleep 120',
].join('\n');

function shouldRun(phase) {
  return selectedPhases.length === 0 || selectedPhases.includes(String(phase));
}

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

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      const response = await fetch(`${origin}/api/settings`);
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
  // The port has to be free before the next server claims it.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/api/settings`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function restartServer() {
  await stopServer();
  await startServer();
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

async function setPreparationScript(script) {
  const response = await api('/api/projects/preparation-script', {
    method: 'PUT',
    body: JSON.stringify({ projectId: projectDir, preparationScript: script }),
  });
  assert.equal(response.ok, true, `could not save the preparation script: ${response.text}`);
}

async function listTasks() {
  const response = await api(`/api/tasks?projectId=${encodeURIComponent(projectDir)}`);
  assert.equal(response.ok, true, `could not list tasks: ${response.text}`);
  return response.json.tasks ?? [];
}

async function readPreparation(taskId) {
  const response = await api(`/api/tasks/${encodeURIComponent(taskId)}/preparation`);
  assert.equal(response.ok, true, `could not read preparation: ${response.text}`);
  return response.json.preparation;
}

async function waitForStatus(taskId, expected, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPreparation(taskId);
    if (last.status === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`status stayed ${last?.status} instead of reaching ${expected}\n${logs()}`);
}

// -------------------------------------------------------------------- ui ---

// The same task shows up under more than one sidebar group (Recent Work and
// its collection), so every row lookup takes the first rendering of it.
function taskRow(taskId) {
  return page.locator(`[data-testid="collection-task-${taskId}"]`).first();
}

/**
 * Switch the right-hand panel away from Scripts.
 *
 * Leaving the tab detaches the terminal surface; the run behind it carries on,
 * which is what the phases that call this are checking.
 */
async function leaveScriptsTab() {
  // Inactive tabs show only their icon, so match on the accessible name.
  await page.getByRole('tab', { name: 'Git' }).first().click({ timeout: 15_000 });
}

function badgeIn(taskId) {
  return taskRow(taskId).locator('[data-testid="task-preparation-badge"]');
}

async function openChat() {
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });
  // The server registers its own working directory as a project and sorts it
  // first, so the fixture has to be selected before anything is created.
  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();
  await page.waitForFunction(
    (dir) => document.querySelector('[data-testid="sidebar-project-context"]')?.textContent?.includes(dir),
    path.basename(projectDir),
    { timeout: 30_000 },
  ).catch(() => {});
}

async function createWorktreeTask(title) {
  const before = new Set((await listTasks()).map((task) => task.id));

  // Sessions created earlier own the open tab, so the empty panel that offers
  // task creation only exists in a fresh one.
  if (await page.getByTestId('empty-panel-mode-task').count() === 0) {
    await page.getByTestId('tab-bar-add').click({ timeout: 30_000 });
  }

  await page.getByTestId('empty-panel-mode-task').click({ timeout: 30_000 });
  await page.getByTestId('empty-panel-task-title-input').fill(title);
  const slugInput = page.getByTestId('empty-panel-branch-slug-input');
  if (await slugInput.count()) await slugInput.fill(title);
  await page.getByTestId('empty-panel-create-session').click();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const fresh = (await listTasks()).find((task) => !before.has(task.id));
    if (fresh?.worktreeBranch) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the worktree task never appeared\n${logs()}`);
}

/**
 * What the attached terminal is showing.
 *
 * xterm keeps the rendered rows in the DOM even when a canvas renderer draws
 * them, so the row text is what a reader can actually see.
 */
async function readTerminalText(scope) {
  const deadline = Date.now() + 20_000;
  let text = '';
  while (Date.now() < deadline) {
    text = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="worktree-scripts-panel"]');
      const rows = view?.querySelector('.xterm-rows');
      return rows ? rows.textContent ?? '' : '';
    });
    if (text.trim().length > 0) return text;
    await page.waitForTimeout(200);
  }
  const diagnosis = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="worktree-scripts-panel"]');
    const screen = view?.querySelector('.xterm-screen');
    return {
      hasView: Boolean(view),
      hasScreen: Boolean(screen),
      screenChildren: screen ? [...screen.children].map((child) => child.className) : [],
      rowCount: view?.querySelectorAll('.xterm-rows > div').length ?? -1,
    };
  });
  serverOutput.push(`[terminal-read] ${JSON.stringify(diagnosis)}\n`);
  return text;
}

/** The view reads its stored output after it opens, so give that a moment. */
async function waitForViewText(view, needle) {
  const deadline = Date.now() + 15_000;
  let text = '';
  while (Date.now() < deadline) {
    text = await view.innerText().catch(() => '');
    if (text.includes(needle)) return text;
    await page.waitForTimeout(200);
  }
  return text;
}

async function openContextMenu(taskId) {
  await taskRow(taskId).click({ button: 'right', timeout: 30_000 });
}

/**
 * Every surface that offers a run asks first, because a run writes over the
 * worktree. Nothing starts until this is answered.
 */
async function confirmRun() {
  await page.getByTestId('preparation-rerun-confirm').click({ timeout: 15_000 });
}

async function capture(name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page?.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

// ----------------------------------------------------------------- setup ---

async function prepareFixtureRepository() {
  await fs.mkdir(projectDir, { recursive: true });
  const git = (args) => run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=Tessera E2E', ...args], { cwd: projectDir });
  await git(['init', '-b', 'main']);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# preparation e2e fixture\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial commit']);
}

async function registerProject() {
  // The fixture lives on the Linux filesystem, so the server has to be told to
  // treat paths that way before it will accept the folder.
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);

  const response = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });
  assert.equal(response.ok, true, `could not register the project: ${response.text}`);
}

// ---------------------------------------------------------------- phases ---

/** Success: the badge shows the run, the terminal attaches, closing it changes nothing. */
async function phase1() {
  await setPreparationScript(SUCCESS_SCRIPT);
  const task = await createWorktreeTask('prep-success');

  const badge = badgeIn(task.id);
  await badge.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(
    await badge.getAttribute('data-preparation-status'),
    'running',
    'the badge should report the run in flight',
  );

  await badge.click();
  const view = page.getByTestId('worktree-scripts-panel');
  await view.waitFor({ state: 'visible', timeout: 30_000 });
  await view.locator('.xterm').first().waitFor({ state: 'attached', timeout: 60_000 });
  const printed = await readTerminalText(view);
  assert.ok(
    printed.includes('preparation-started'),
    `the attached terminal should be showing the live run: ${printed.slice(0, 400)}`,
  );

  // The script is recorded as the run starts, so "what is this doing?" has an
  // answer while it is still doing it — not only once it has finished.
  const runningScript = await view
    .getByTestId('worktree-scripts-script-body')
    .innerText({ timeout: 30_000 });
  assert.ok(
    runningScript.includes('preparation-started'),
    `the script should be readable during the run: ${runningScript}`,
  );

  // Detaching must not stop the run. The close button, not Escape: the
  // attached terminal has the keyboard.
  await leaveScriptsTab();
  await view.waitFor({ state: 'detached', timeout: 15_000 });
  const afterClose = await readPreparation(task.id);
  assert.equal(afterClose.status, 'running', 'closing the view must leave the run alone');

  const finished = await waitForStatus(task.id, 'succeeded');
  assert.equal(finished.exitCode, 0);
  await badge.waitFor({ state: 'detached', timeout: 30_000 });

  const worktreePath = (await listTasks()).find((entry) => entry.id === task.id)?.workDir;
  const prepared = await fs.readFile(path.join(worktreePath, 'prepared.txt'), 'utf8');
  assert.equal(prepared, 'ok', 'the script should have written into the worktree');

  results.push({ phase: 1, taskId: task.id, worktreePath, status: finished.status });
  return { taskId: task.id, worktreePath };
}

/** Failure: the badge turns red, the output survives the run, a re-run clears it. */
async function phase2(taskId) {
  await setPreparationScript(FAILING_SCRIPT);

  // What the re-run menu item is gated on, from both sides.
  const projects = await api('/api/sessions/projects');
  const fixture = (projects.json?.projects ?? []).find((entry) => entry.encodedDir === projectDir);
  const task = (await listTasks()).find((entry) => entry.id === taskId);
  serverOutput.push(`[gate] ${JSON.stringify({
    hasPreparationScript: fixture?.hasPreparationScript,
    projectKeys: (projects.json?.projects ?? []).map((entry) => entry.encodedDir),
    workDir: task?.workDir,
    worktreeBranch: task?.worktreeBranch,
    preparationStatus: task?.preparationStatus,
  })}\n`);

  await openContextMenu(taskId);
  await page.getByTestId('ctx-run-preparation').click({ timeout: 15_000 });
  await confirmRun();

  const failed = await waitForStatus(taskId, 'failed');
  assert.equal(failed.exitCode, 3, 'the exit code should be the one the script returned');
  assert.ok(failed.output?.includes('preparation-boom'), `stored output should hold the run: ${failed.output}`);

  const badge = badgeIn(taskId);
  await badge.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await badge.getAttribute('data-preparation-status'), 'failed');

  await badge.click();
  const view = page.getByTestId('worktree-scripts-panel');
  await view.waitFor({ state: 'visible', timeout: 30_000 });
  const shown = await waitForViewText(view, 'preparation-boom');
  assert.ok(shown.includes('preparation-boom'), `the view should read back the output: ${shown}`);
  assert.ok(/3/.test(shown), `the view should report the exit code: ${shown}`);
  // The log names the line that failed, not just what it printed: output with
  // nothing to attribute it to is what makes a failed run hard to read.
  assert.ok(shown.includes('+ exit 3'), `the log should trace the failing line: ${shown}`);

  // And the script that produced the log is right there, whole and in order,
  // rather than something to be reconstructed from the output.
  const scriptShown = await page.getByTestId('worktree-scripts-script-body').innerText();
  assert.ok(
    scriptShown.includes('echo "preparation-boom"') && scriptShown.includes('exit 3'),
    `the panel should show the script the run ran: ${scriptShown}`,
  );

  // Re-run from the view itself, with a script that now succeeds.
  await setPreparationScript(SUCCESS_SCRIPT);

  // Backing out of the question leaves the failed run exactly as it was: a
  // dialog that runs anyway is worse than no dialog.
  await page.getByTestId('task-preparation-rerun').click();
  await page.getByTestId('preparation-rerun-cancel').click({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  assert.equal(
    (await readPreparation(taskId)).status,
    'failed',
    'cancelling the dialog must not start a run',
  );

  await page.getByTestId('task-preparation-rerun').click();
  await confirmRun();
  const succeeded = await waitForStatus(taskId, 'succeeded');
  assert.equal(succeeded.exitCode, 0);
  await badgeIn(taskId).waitFor({ state: 'detached', timeout: 30_000 });

  // The badge going away must not take the run with it: the Scripts tab is
  // still open on it, and what it printed is still there to read.
  const afterSuccess = await waitForViewText(view, 'preparation-finished');
  assert.ok(
    afterSuccess.includes('preparation-finished'),
    `a successful run stays readable after its badge goes: ${afterSuccess}`,
  );
  await leaveScriptsTab();

  results.push({ phase: 2, taskId, failedExitCode: failed.exitCode, recovered: succeeded.status });
}

/** A failure outlives a restart, and the worktree it failed in stays usable. */
async function phase3(taskId, worktreePath) {
  await setPreparationScript(FAILING_SCRIPT);
  await openContextMenu(taskId);
  await page.getByTestId('ctx-run-preparation').click({ timeout: 15_000 });
  await confirmRun();
  await waitForStatus(taskId, 'failed');

  await restartServer();
  await openChat();

  const afterRestart = await readPreparation(taskId);
  assert.equal(afterRestart.status, 'failed', 'a failure must survive the restart');
  assert.ok(
    afterRestart.output?.includes('preparation-boom'),
    'the output must still be readable after the restart',
  );

  const badge = badgeIn(taskId);
  await badge.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await badge.getAttribute('data-preparation-status'), 'failed');

  // The worktree a failed preparation left behind is still a working checkout.
  const status = await run('git', ['-C', worktreePath, 'status', '--porcelain']);
  assert.equal(typeof status.stdout, 'string');
  const branch = await run('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  assert.ok(branch.stdout.trim().length > 0, 'the worktree should still be on its branch');

  results.push({ phase: 3, taskId, survivedRestart: afterRestart.status, worktreeBranch: branch.stdout.trim() });
}

/** A run cut short by the app ends as a failure that explains itself. */
async function phase4(taskId) {
  await setPreparationScript(LONG_SCRIPT);
  await openContextMenu(taskId);
  await page.getByTestId('ctx-run-preparation').click({ timeout: 15_000 });
  await confirmRun();
  await waitForStatus(taskId, 'running');

  await restartServer();
  await openChat();

  const interrupted = await readPreparation(taskId);
  assert.equal(interrupted.status, 'failed', 'a run cut short must not stay "running"');
  assert.equal(interrupted.exitCode, null, 'no process was waited on, so there is no exit code');

  const badge = badgeIn(taskId);
  await badge.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await badge.getAttribute('data-preparation-status'), 'failed');
  await badge.click();
  const view = page.getByTestId('worktree-scripts-panel');
  await view.waitFor({ state: 'visible', timeout: 30_000 });
  const shown = await view.innerText();
  assert.ok(
    /still running|아직 실행/i.test(shown) || shown.trim().length > 0,
    `the view should explain the interruption: ${shown}`,
  );
  await leaveScriptsTab();
  await view.waitFor({ state: 'detached', timeout: 15_000 });

  results.push({ phase: 4, taskId, interrupted: interrupted.status, exitCode: interrupted.exitCode });
}

/** No script means no preparation at all: no status, no badge. */
async function phase5() {
  await setPreparationScript(null);
  const task = await createWorktreeTask('prep-none');

  const preparation = await readPreparation(task.id);
  assert.equal(preparation.status, 'never_run', 'a project without a script must not record a run');

  await taskRow(task.id).waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await badgeIn(task.id).count(), 0, 'a task with nothing to prepare carries no badge');

  await openContextMenu(task.id);
  const menu = page.locator('[data-testid="ctx-run-preparation"]');
  const offered = await menu.count();
  await page.keyboard.press('Escape');
  assert.equal(offered, 0, 'a project without a script must not offer a re-run');

  results.push({ phase: 5, taskId: task.id, status: preparation.status });
}

// ------------------------------------------------------------------ main ---

let failure = null;
try {
  await prepareFixtureRepository();
  await startServer();
  await registerProject();

  // Without WebGL xterm falls back to its DOM renderer, which is the only way
  // to read back what the attached terminal is showing.
  browser = await chromium.launch({ headless, args: ['--disable-webgl', '--disable-webgl2'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));
  await openChat();

  let created = null;
  if (shouldRun(1)) created = await phase1();
  if (!created) {
    const existing = (await listTasks()).find((task) => task.worktreeBranch);
    created = existing ? { taskId: existing.id, worktreePath: existing.workDir } : null;
  }

  if (shouldRun(2)) await phase2(created.taskId);
  if (shouldRun(3)) await phase3(created.taskId, created.worktreePath);
  if (shouldRun(4)) await phase4(created.taskId);
  if (shouldRun(5)) await phase5();

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  failure = error;
  const shot = await capture('failure');
  console.error(`e2e failed; screenshot at ${shot}`);
  console.error(error);
  console.error(`--- server log tail ---\n${logs().slice(-8000)}`);
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
  // The managed worktrees live under the user's home, keyed by the fixture's
  // own name — only this run's directory is removed.
  await fs.rm(managedWorktreeDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

if (failure) process.exit(1);
