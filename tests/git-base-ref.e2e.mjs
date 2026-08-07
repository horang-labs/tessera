/**
 * End-to-end coverage for the base a worktree was cut from.
 *
 * Three things are checked against a real server, a real browser and real git
 * repositories, all inside throwaway directories:
 *
 *   1. A worktree created the way the app creates one records its base, and the
 *      Git panel shows it.
 *   2. A worktree created from another branch records that branch, and opening
 *      a pull request targets it — verified by a fake `gh` on PATH that records
 *      the argv it was handed.
 *   3. A clone whose remote is not called `origin` still resolves its default
 *      branch, which is what §8's push confirmation compares against.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1,2 while iterating.
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

const port = Number(process.env.TESSERA_E2E_PORT ?? 34219);
const origin = `http://127.0.0.1:${port}`;
const headless = process.env.TESSERA_E2E_HEADED !== '1';
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR ?? path.join(os.tmpdir(), 'tessera-base-ref-e2e');
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-base-data-'));
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-base-fixture-'));
const suffix = path.basename(fixtureDir).slice(-6);
// The managed worktree root is keyed by the project's own name, so each fixture
// needs a unique one: in WSL mode that root is the user's home, not the data dir.
const originProjectName = `base-e2e-origin-${suffix}`;
const upstreamProjectName = `base-e2e-upstream-${suffix}`;
const originProjectDir = path.join(fixtureDir, originProjectName);
const upstreamProjectDir = path.join(fixtureDir, upstreamProjectName);
const remoteDir = path.join(fixtureDir, 'remote.git');
/**
 * A home of the run's own, used for the phases that must not reach a real `gh`.
 *
 * The CLI spawner probes a login shell for PATH, and against the user's real
 * home their rc puts the real `gh` ahead of anything this run prepends — which
 * is how the first attempt at phase 2 dialled GitHub for real. With no rc to
 * source, the PATH handed to that shell is the PATH it hands back, so the fake
 * `gh` wins; a real one reached from here would find no credentials either.
 *
 * The cost is that no CLI provider is discoverable from it, and phase 1 creates
 * its worktree through the UI, which requires one. That phase therefore runs
 * against the real home and the server is restarted before the rest.
 */
const serverHome = path.join(fixtureDir, 'home');
const managedRoots = [originProjectName, upstreamProjectName].flatMap((name) => [
  path.join(serverHome, '.tessera', 'worktrees', name),
  path.join(os.homedir(), '.tessera', 'worktrees', name),
]);

const fakeBinDir = path.join(fixtureDir, 'fake-bin');
const ghCallLog = path.join(fixtureDir, 'gh-calls.log');
const ghBaseFile = path.join(fixtureDir, 'gh-base.txt');

const GITHUB_URL = 'https://github.com/tessera-e2e/fixture.git';

const serverOutput = [];
let server = null;
let browser = null;
let page = null;
let appSecret = null;
const results = [];

function shouldRun(phase) {
  return selectedPhases.length === 0 || selectedPhases.includes(String(phase));
}

function logs() {
  return serverOutput.join('');
}

function git(args, cwd) {
  return run(
    'git',
    ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=Tessera E2E', ...args],
    { cwd },
  );
}

// --------------------------------------------------------------- fixtures ---

/**
 * A fake `gh` that records its argv and answers the two calls `create_pr`
 * makes. Nothing here reaches GitHub: what is under test is which arguments
 * the action builds, and a real `gh` would only be able to answer that by
 * opening a pull request against a repository that does not exist.
 */
async function installFakeGh() {
  await fs.mkdir(fakeBinDir, { recursive: true });
  const script = `#!/usr/bin/env bash
for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(ghCallLog)}; done
printf -- '--- end ---\\n' >> ${JSON.stringify(ghCallLog)}

if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  base=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--base" ]; then base="$arg"; fi
    prev="$arg"
  done
  printf '%s' "$base" > ${JSON.stringify(ghBaseFile)}
  echo "https://github.com/tessera-e2e/fixture/pull/7"
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  base="$(cat ${JSON.stringify(ghBaseFile)} 2>/dev/null)"
  if [ -z "$base" ]; then base="main"; fi
  printf '{"number":7,"url":"https://github.com/tessera-e2e/fixture/pull/7","baseRefName":"%s"}\\n' "$base"
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
`;
  const file = path.join(fakeBinDir, 'gh');
  await fs.writeFile(file, script, 'utf8');
  await fs.chmod(file, 0o755);
}

async function readGhCalls() {
  const raw = await fs.readFile(ghCallLog, 'utf8').catch(() => '');
  return raw
    .split('--- end ---\n')
    .map((block) => block.split('\n').filter(Boolean))
    .filter((argv) => argv.length > 0);
}

/**
 * One bare remote, cloned twice: once the ordinary way and once with the remote
 * deliberately named something other than `origin`, which is the case phase 3
 * exists for.
 */
async function prepareFixtures() {
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.mkdir(serverHome, { recursive: true });
  await run('git', ['init', '--bare', '-b', 'main', remoteDir]);

  await run('git', ['clone', remoteDir, originProjectDir]);
  await fs.writeFile(path.join(originProjectDir, 'README.md'), '# base-ref e2e fixture\n', 'utf8');
  await git(['add', '-A'], originProjectDir);
  await git(['commit', '-m', 'initial commit'], originProjectDir);
  await git(['push', '-u', 'origin', 'main'], originProjectDir);

  // The parent phase 2 branches from. It has to exist on the remote too: `gh`
  // resolves `--base` there, so an unpublished parent is one the action must
  // decline to pass.
  await git(['checkout', '-b', 'feature/parent'], originProjectDir);
  await fs.writeFile(path.join(originProjectDir, 'PARENT.md'), 'parent work\n', 'utf8');
  await git(['add', '-A'], originProjectDir);
  await git(['commit', '-m', 'parent commit'], originProjectDir);
  await git(['push', '-u', 'origin', 'feature/parent'], originProjectDir);
  await git(['checkout', 'main'], originProjectDir);

  await run('git', ['clone', '-o', 'upstream', remoteDir, upstreamProjectDir]);
  // A clone from a bare repository leaves no remote HEAD; the app's own clones
  // have one, and resolving it is exactly what is under test.
  await git(['remote', 'set-head', 'upstream', '--auto'], upstreamProjectDir);
  await git(['remote', 'set-head', 'origin', '--auto'], originProjectDir);
}

// ---------------------------------------------------------------- server ---

async function startServer({ isolatedHome = false } = {}) {
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
      // The fake `gh` has to win over any real one the host has installed.
      PATH: `${fakeBinDir}${path.delimiter}${env.PATH ?? ''}`,
      ...(isolatedHome ? { HOME: serverHome } : {}),
      NODE_ENV: 'development',
      // Without this the browser's WebSocket is refused — `extraHTTPHeaders`
      // does not reach an upgrade request — and the UI never receives the
      // provider list the worktree form waits on.
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
 * The account the browser's cookie will name.
 *
 * Written before the server starts, because the request gate looks the token's
 * subject up in this file and an Electron-runtime server creates no account of
 * its own — `/api/auth/setup` answers 409 and leaves the file absent. The
 * password hash is never used: nothing here logs in.
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

/**
 * A JWT cookie for the browser, signed with the server's own key.
 *
 * The app secret carries every HTTP call this suite makes, but a WebSocket
 * upgrade never sees `extraHTTPHeaders`, so without a cookie the renderer's
 * socket is refused and the UI receives nothing the server pushes.
 */
async function mintBrowserToken() {
  const privateKey = await fs.readFile(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
  return jwt.sign(
    { sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
    privateKey,
    { algorithm: 'RS256', expiresIn: 3600 },
  );
}

async function registerProjects() {
  // The fixtures live on the Linux filesystem, so the server has to be told to
  // treat paths that way before it will accept the folders.
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);

  for (const dir of [originProjectDir, upstreamProjectDir]) {
    const response = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ folderPath: dir }),
    });
    assert.equal(response.ok, true, `could not register ${dir}: ${response.text}`);
  }
}

async function listTasks(projectDir) {
  const response = await api(`/api/tasks?projectId=${encodeURIComponent(projectDir)}`);
  assert.equal(response.ok, true, `could not list tasks: ${response.text}`);
  return response.json.tasks ?? [];
}

async function readRecordedBase(projectDir, branch) {
  const result = await git(['config', '--local', '--get', `branch.${branch}.base`], projectDir)
    .catch(() => null);
  return result?.stdout.trim() ?? null;
}

async function createSession(workDir, projectDir, taskId) {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir,
      parentProjectId: projectDir,
      providerId: 'claude-code',
      title: 'base-ref e2e',
      ...(taskId ? { taskId } : {}),
    }),
  });
  assert.equal(response.ok, true, `could not create a session: ${response.text}`);
  const id = response.json?.session?.id ?? response.json?.id ?? response.json?.sessionId;
  assert.ok(id, `the session response carried no id: ${response.text}`);
  return id;
}

async function readPanel(sessionId) {
  const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/git`);
  assert.equal(response.ok, true, `could not read the git panel: ${response.text}`);
  return response.json;
}

async function runGitAction(sessionId, action) {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/git/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

// -------------------------------------------------------------------- ui ---

async function openChat(projectDir) {
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });
  // The server registers its own working directory as a project and sorts it
  // first, so the fixture has to be selected before anything is created.
  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();
  await page.waitForTimeout(500);
}

/**
 * A task with a worktree behind it, made through the route the app's own
 * worktree form posts to. Driving that form instead would be closer to the
 * user, but it stays disabled until the renderer has a CLI provider, which is
 * about the agent runtime rather than about anything here.
 */
async function createWorktreeTask(title, projectDir, baseRef = null) {
  const task = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectDir, title }),
  });
  assert.equal(task.ok, true, `could not create the task: ${task.text}`);
  const taskId = task.json?.task?.id ?? task.json?.id;
  assert.ok(taskId, `the task response carried no id: ${task.text}`);

  const created = await api('/api/worktrees', {
    method: 'POST',
    body: JSON.stringify({
      projectDir,
      branchSlug: title,
      taskId,
      ...(baseRef ? { baseRef } : {}),
    }),
  });
  assert.equal(created.ok, true, `could not create the worktree: ${created.text}`);

  return { id: taskId, branch: created.json.branchName, worktreePath: created.json.worktreePath };
}

async function openGitTab() {
  // The right-hand panel starts collapsed, and its tabs do not exist until it
  // is open.
  const gitTab = page.getByRole('tab', { name: 'Git' }).first();
  if (await gitTab.count() === 0) {
    await page.getByRole('button', { name: /git panel/i }).first()
      .click({ timeout: 30_000 });
  }
  await gitTab.click({ timeout: 30_000 });
}

async function capture(name) {
  await fs.mkdir(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await page?.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

// ---------------------------------------------------------------- phases ---

/**
 * The path the app itself takes. A worktree made from the sidebar records the
 * branch the project had checked out, and the panel names it.
 */
async function phase1() {
  const task = await createWorktreeTask('base-shown', originProjectDir);

  const recorded = await readRecordedBase(originProjectDir, task.branch);
  assert.equal(
    recorded,
    'refs/heads/main',
    'a worktree created through the app must record the branch it was cut from',
  );

  await createSession(task.worktreePath, originProjectDir, task.id);
  await openChat(originProjectDir);
  await page.locator(`[data-testid="collection-task-${task.id}"]`).first()
    .click({ timeout: 30_000 });
  await openGitTab();
  const row = page.getByTestId('git-panel-base-ref');
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  const shown = (await row.innerText()).trim();
  const shot = await capture('phase1-panel-base');
  assert.equal(shown, 'main', `the panel should name the base: ${shown}`);

  results.push({ phase: 1, branch: task.branch, recorded, shown, screenshot: shot });
}

/**
 * A worktree cut from another feature branch. The recorded base is that branch,
 * and it is what the pull request is opened against — not the repository
 * default, which is what `gh` would have chosen on its own.
 */
async function phase2() {
  const branch = 'feature/child-e2e';
  const created = await api('/api/worktrees', {
    method: 'POST',
    body: JSON.stringify({
      projectDir: originProjectDir,
      branchSlug: 'child-e2e',
      branchPrefix: 'feature/',
      baseRef: 'feature/parent',
    }),
  });
  assert.equal(created.ok, true, `could not create the worktree: ${created.text}`);
  const worktreePath = created.json.worktreePath;
  assert.equal(created.json.branchName, branch);

  const recorded = await readRecordedBase(originProjectDir, branch);
  assert.equal(
    recorded,
    'refs/heads/feature/parent',
    'the start point the caller named is what must be recorded',
  );

  const sessionId = await createSession(worktreePath, originProjectDir);
  const panel = await readPanel(sessionId);
  assert.equal(panel.baseRef, 'refs/heads/feature/parent', 'the panel reads the recorded base back');

  // Something to open a pull request about, then publish it: the action only
  // runs on a branch that tracks.
  await fs.writeFile(path.join(worktreePath, 'CHILD.md'), 'child work\n', 'utf8');
  await git(['add', '-A'], worktreePath);
  await git(['commit', '-m', 'child commit'], worktreePath);

  const pushed = await runGitAction(sessionId, 'push');
  assert.equal(pushed.ok, true, `publish failed: ${pushed.text}`);

  // The remote is a directory on disk, which is what let the push work; `gh`
  // needs it to look like GitHub, and the fake never dials out.
  await git(['remote', 'set-url', 'origin', GITHUB_URL], originProjectDir);

  const opened = await runGitAction(sessionId, 'create_pr');
  assert.equal(opened.ok, true, `create_pr failed: ${opened.text}`);
  assert.ok(
    opened.json?.result?.ok ?? opened.json?.ok,
    `create_pr reported a failure: ${opened.text}`,
  );

  const calls = await readGhCalls();
  const createCall = calls.find((argv) => argv[0] === 'pr' && argv[1] === 'create');
  assert.ok(createCall, `gh pr create was never invoked: ${JSON.stringify(calls)}`);
  const baseIndex = createCall.indexOf('--base');
  assert.notEqual(baseIndex, -1, `no --base was passed: ${JSON.stringify(createCall)}`);
  assert.equal(
    createCall[baseIndex + 1],
    'feature/parent',
    `the pull request must target the recorded base: ${JSON.stringify(createCall)}`,
  );
  assert.equal(createCall[createCall.indexOf('--head') + 1], branch);

  results.push({ phase: 2, branch, recorded, ghArgv: createCall });
}

/**
 * §8's confirmation compares the branch about to be pushed against the default
 * branch, so a clone that named its remote anything but `origin` used to have
 * nothing to compare and pushed to its own default branch unquestioned.
 */
async function phase3() {
  const sessionId = await createSession(upstreamProjectDir, upstreamProjectDir);
  const panel = await readPanel(sessionId);

  assert.equal(
    panel.defaultBranch,
    'main',
    `the default branch must resolve through a remote called something else: ${JSON.stringify(panel.defaultBranch)}`,
  );
  assert.equal(panel.branch, 'main');
  assert.equal(panel.hasRemote, true);

  results.push({ phase: 3, defaultBranch: panel.defaultBranch });
}

// ------------------------------------------------------------------ main ---

let failure = null;
try {
  await installFakeGh();
  await prepareFixtures();
  await writeBrowserUser();
  await startServer();
  await registerProjects();

  const token = await mintBrowserToken();
  browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addCookies([
    { name: 'jwt', value: token, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));

  if (shouldRun(1)) await phase1();

  if (shouldRun(2) || shouldRun(3)) {
    // Everything from here runs against the isolated home, so the fake `gh`
    // is the only one the action can reach.
    await browser.close().catch(() => {});
    browser = null;
    page = null;
    await stopServer();
    await startServer({ isolatedHome: true });
  }

  if (shouldRun(2)) await phase2();
  if (shouldRun(3)) await phase3();

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
  // The managed worktrees live under the user's home, keyed by each fixture's
  // own name — only this run's directories are removed.
  for (const root of managedRoots) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
}

if (failure) process.exit(1);
