import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);
const port = Number(process.env.TESSERA_E2E_PORT ?? 34322);
const origin = `http://127.0.0.1:${port}`;
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-subsession-reorder-'));
const descriptor = path.join(dataDir, 'control.json');
const evidenceDir = process.env.TESSERA_EVIDENCE_DIR
  ?? path.join(process.cwd(), '.tmp', 'sub-session-reorder-evidence');
const suffix = path.basename(dataDir).toLowerCase();
const serverOutput = [];
let server;
let browser;
let createdWorktree;
let authCookie = '';

function cleanEnv() {
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT',
    'TESSERA_ELECTRON_SERVER', 'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT',
    'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
  ]) delete env[key];
  return env;
}

async function startServer() {
  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...cleanEnv(),
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_CONTROL_DESCRIPTOR_PATH: descriptor,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => serverOutput.push(chunk.toString()));
  }
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (server.exitCode !== null) throw new Error(serverOutput.join(''));
    try {
      if ((await fetch(`${origin}/api/auth/setup`)).ok && await fs.stat(descriptor)) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server timeout:\n${serverOutput.join('')}`);
}

async function api(url, body, method = 'POST') {
  const headers = { 'content-type': 'application/json', origin };
  if (authCookie) headers.cookie = authCookie;
  const response = await fetch(
    `${origin}${url}`,
    body ? { method, headers, body: JSON.stringify(body) } : { headers },
  );
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) authCookie = setCookie.split(';', 1)[0];
  const text = await response.text();
  assert.equal(response.ok, true, `${url}: ${text}`);
  return JSON.parse(text);
}

async function cli(args) {
  const result = await run(
    process.execPath,
    ['bin/tessera.mjs', ...args, '--json', '--control-descriptor', descriptor],
    { cwd: process.cwd(), env: cleanEnv(), maxBuffer: 2 ** 20 },
  );
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout || result.stderr);
  return envelope.data;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  let exited = false;
  const exit = new Promise((resolve) => server.once('exit', () => { exited = true; resolve(); }));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!exited && server.exitCode === null) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}

try {
  await fs.mkdir(evidenceDir, { recursive: true });
  await startServer();
  await api('/api/auth/setup', { username: 'subsession-reorder', password: 'subsession-reorder' });
  const projects = await api('/api/sessions/projects');
  const project = projects.projects.find((item) => item.decodedPath === process.cwd());
  assert.ok(project?.projectWorktree?.id, 'current Project Worktree was not registered');
  await api('/api/settings', {
    agentEnvironment: 'wsl',
    showProviderIcons: false,
    showRecentWork: false,
  }, 'PUT');

  const branch = `subsession-reorder-${suffix}`;
  createdWorktree = await cli([
    'worktree', 'create', '--project', project.encodedDir,
    '-b', branch, 'HEAD', '--title', 'Sub-session reorder',
  ]);
  const taskProjection = await api(`/api/tasks?projectId=${encodeURIComponent(project.encodedDir)}`);
  const task = taskProjection.tasks.find((candidate) =>
    candidate.worktreeId === createdWorktree.worktreeId
  );
  assert.ok(task, 'created Worktree must be projected into the current Project');

  const createdSessions = [];
  for (const title of ['First Session', 'Second Session']) {
    createdSessions.push(await api('/api/sessions', {
      workDir: createdWorktree.path,
      parentProjectId: project.encodedDir,
      taskId: task.id,
      worktreeBranch: createdWorktree.branch,
      providerId: 'codex',
      executionMode: 'gui',
      title,
      hasCustomTitle: true,
    }));
  }

  browser = await chromium.launch({ headless: process.env.TESSERA_HEADFUL !== '1' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const [cookieName, cookieValue] = authCookie.split('=', 2);
  await page.context().addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
  await page.goto(`${origin}/chat`, { waitUntil: 'networkidle' });

  const taskRow = page.locator(`[data-worktree-id="${createdWorktree.worktreeId}"]`);
  await taskRow.waitFor({ timeout: 30_000 });
  const observerPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await observerPage.context().addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
  await observerPage.goto(`${origin}/chat`, { waitUntil: 'networkidle' });
  await observerPage.locator(
    `[data-worktree-id="${createdWorktree.worktreeId}"]`,
  ).waitFor({ timeout: 30_000 });
  assert.equal(await taskRow.getAttribute('data-linked-worktree-density'), 'expanded');
  const rows = page.locator(
    '[data-testid^="collection-subsession-"][data-session-id][draggable="true"]',
  );
  await rows.first().waitFor();
  const initialOrder = await rows.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-session-id')),
  );
  assert.deepEqual(new Set(initialOrder), new Set(createdSessions.map((session) => session.sessionId)));
  await page.screenshot({ path: path.join(evidenceDir, '01-before-drag.png'), fullPage: true });

  const reorderResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions/reorder') && response.request().method() === 'PATCH',
  );
  const firstRow = rows.nth(0);
  const firstBox = await firstRow.boundingBox();
  assert.ok(firstBox, 'first Session row must have a drag target');
  await rows.nth(1).dragTo(firstRow, {
    targetPosition: { x: firstBox.width / 2, y: 1 },
  });
  assert.equal((await reorderResponse).ok(), true);
  const expectedOrder = [initialOrder[1], initialOrder[0]];
  await page.waitForFunction(
    (expected) => JSON.stringify(
      [...document.querySelectorAll(
        '[data-testid^="collection-subsession-"][data-session-id][draggable="true"]',
      )].map((row) => row.getAttribute('data-session-id')),
    ) === JSON.stringify(expected),
    expectedOrder,
  );
  await observerPage.waitForFunction(
    (expected) => JSON.stringify(
      [...document.querySelectorAll(
        '[data-testid^="collection-subsession-"][data-session-id][draggable="true"]',
      )].map((row) => row.getAttribute('data-session-id')),
    ) === JSON.stringify(expected),
    expectedOrder,
  );
  await page.screenshot({ path: path.join(evidenceDir, '02-after-drag.png'), fullPage: true });
  await observerPage.screenshot({
    path: path.join(evidenceDir, '03-observer-window-synced.png'),
    fullPage: true,
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-worktree-id="${createdWorktree.worktreeId}"]`).waitFor();
  assert.deepEqual(
    await page.locator(
      '[data-testid^="collection-subsession-"][data-session-id][draggable="true"]',
    ).evaluateAll((items) => items.map((item) => item.getAttribute('data-session-id'))),
    expectedOrder,
  );
  await page.screenshot({ path: path.join(evidenceDir, '04-after-reload.png'), fullPage: true });
  console.log(`Sub-session reorder passed; evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  await stopServer();
  if (createdWorktree) {
    await run('git', ['worktree', 'remove', '--force', createdWorktree.path]).catch(() => undefined);
    await run('git', ['branch', '-D', createdWorktree.branch]).catch(() => undefined);
  }
  await fs.rm(dataDir, { recursive: true, force: true });
}
