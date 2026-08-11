import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);
const port = Number(process.env.TESSERA_E2E_PORT ?? 34336);
const origin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-session-archive-'));
const descriptor = path.join(dataDir, 'control.json');
const evidenceDir = process.env.TESSERA_EVIDENCE_DIR
  ?? path.join(process.cwd(), '.tmp', 'issue-336-evidence');
const branch = `t336-${path.basename(dataDir).toLowerCase()}`;
const serverOutput = [];
let server;
let browser;
let worktree;
let authCookie = '';

function cleanEnv() {
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT',
    'TESSERA_ELECTRON_SERVER', 'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT',
    'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID', 'TESSERA_ELECTRON_AUTH_BYPASS',
  ]) delete env[key];
  return env;
}

async function startServer() {
  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(), detached: true,
    env: {
      ...cleanEnv(), NODE_ENV: 'development', PORT: String(port),
      TESSERA_DATA_DIR: dataDir, TESSERA_CONTROL_DESCRIPTOR_PATH: descriptor,
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
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server timeout:\n${serverOutput.join('')}`);
}

async function api(url, body, method = 'POST') {
  const headers = { 'content-type': 'application/json', origin };
  if (authCookie) headers.cookie = authCookie;
  const response = await fetch(`${origin}${url}`, body
    ? { method, headers, body: JSON.stringify(body) }
    : { headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) authCookie = setCookie.split(';', 1)[0];
  const text = await response.text();
  assert.equal(response.ok, true, `${url}: ${text}`);
  return JSON.parse(text);
}

async function cli(args) {
  const result = await run(process.execPath, [
    'bin/tessera.mjs', ...args, '--json', '--control-descriptor', descriptor,
  ], { cwd: process.cwd(), env: cleanEnv(), maxBuffer: 2 ** 20 });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true, result.stdout || result.stderr);
  return envelope.data;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}

try {
  await fs.mkdir(evidenceDir, { recursive: true });
  await startServer();
  await api('/api/auth/setup', { username: 'issue-336', password: 'issue-336' });
  const projects = await api('/api/sessions/projects');
  const project = projects.projects.find((item) => item.decodedPath === process.cwd());
  assert.ok(project?.projectWorktree?.id);
  await api('/api/settings', { agentEnvironment: 'wsl', showRecentWork: false }, 'PUT');
  worktree = await cli([
    'worktree', 'create', '--project', project.encodedDir,
    '-b', branch, 'HEAD', '--title', 'Archive lifecycle',
  ]);
  const tasks = await api(`/api/tasks?projectId=${encodeURIComponent(project.encodedDir)}`);
  const task = tasks.tasks.find((item) => item.worktreeId === worktree.worktreeId);
  assert.ok(task);
  const created = await api('/api/sessions', {
    workDir: worktree.path, parentProjectId: project.encodedDir, taskId: task.id,
    worktreeBranch: worktree.branch, providerId: 'codex', executionMode: 'gui',
    title: 'Canonical task Session', hasCustomTitle: true,
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const [cookieName, cookieValue] = authCookie.split('=', 2);
  await page.context().addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/archive')) {
      requests.push(new URL(request.url()).pathname);
    }
  });
  await page.goto(`${origin}/chat`, { waitUntil: 'networkidle' });
  const row = page.locator(`[data-worktree-id="${worktree.worktreeId}"]`);
  await row.waitFor({ timeout: 30_000 });
  assert.equal(await row.getAttribute('data-linked-worktree-density'), 'composite');

  async function restoreSession() {
    await api(`/api/sessions/${created.sessionId}/archive`, { archived: false }, 'PATCH');
    await page.reload({ waitUntil: 'networkidle' });
    await row.waitFor();
    assert.equal(await row.getAttribute('data-linked-worktree-density'), 'composite');
  }

  async function expectZeroSessionWorktree() {
    await row.waitFor();
    await page.waitForFunction((id) => document.querySelector(
      `[data-worktree-id="${id}"][data-linked-worktree-density="standalone"]`,
    ), worktree.worktreeId);
    assert.equal(await row.locator('[data-session-id]').count(), 0);
  }

  await row.hover();
  const quickArchive = page.getByTestId(`collection-session-quick-archive-${created.sessionId}`);
  await page.screenshot({ path: path.join(evidenceDir, '01-composite-session-action.png') });
  await quickArchive.click();
  await quickArchive.click();
  await expectZeroSessionWorktree();
  await restoreSession();

  await row.click();
  await page.getByTestId('panel-title-drag-handle').click({ button: 'right' });
  await page.getByTestId('ctx-archive').click();
  await expectZeroSessionWorktree();
  await restoreSession();

  await row.click();
  const composer = page.locator(`textarea[data-session-input="${created.sessionId}"]`);
  await composer.fill('/archive');
  await composer.press('Enter');
  await expectZeroSessionWorktree();
  await page.screenshot({ path: path.join(evidenceDir, '02-zero-session-worktree.png') });
  await restoreSession();

  await row.click({ button: 'right' });
  const taskArchive = page.getByTestId('ctx-archive-worktree-task');
  await taskArchive.waitFor();
  await page.screenshot({ path: path.join(evidenceDir, '03-explicit-worktree-task-action.png') });
  await taskArchive.click();
  await row.waitFor({ state: 'detached' });

  assert.deepEqual(requests, [
    `/api/sessions/${created.sessionId}/archive`,
    `/api/sessions/${created.sessionId}/archive`,
    `/api/sessions/${created.sessionId}/archive`,
    `/api/archive/tasks/${task.id}`,
  ]);
  console.log(`Session/Worktree archive acceptance passed; evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  await stopServer();
  if (worktree) await run('git', ['worktree', 'remove', '--force', worktree.path]).catch(() => undefined);
  await run('git', ['branch', '-D', branch]).catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
}
