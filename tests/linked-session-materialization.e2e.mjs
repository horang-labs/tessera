import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const run = promisify(execFile);
const port = Number(process.env.TESSERA_E2E_PORT ?? 34333);
const origin = `http://127.0.0.1:${port}`;
const evidenceDir = process.env.TESSERA_EVIDENCE_DIR
  ?? path.join(process.cwd(), '.tmp', 'issue-333-evidence');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-333-data-'));
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-333-project-'));
const projectDir = path.join(fixtureRoot, 'project');
const logs = [];
let server;
let browser;
let page;
let appSecret = '';
let worktreePath = '';
let branchName = '';

async function api(pathname, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      origin,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${pathname}: ${text}`);
  return JSON.parse(text);
}

async function startServer() {
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT',
    'TESSERA_ELECTRON_SERVER', 'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT',
    'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
  ]) delete env[key];
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
    stream.on('data', (chunk) => logs.push(chunk.toString()));
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(logs.join(''));
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      if ((await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server timeout:\n${logs.join('')}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

try {
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'README.md'), '# Issue 333\n');
  await run('git', ['init', '-b', 'main'], { cwd: projectDir });
  await run('git', ['add', 'README.md'], { cwd: projectDir });
  await run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', 'commit', '-m', 'fixture'], { cwd: projectDir });
  await startServer();
  await api('/api/settings', { agentEnvironment: 'wsl', kanbanSessionOpenMode: 'peek' }, 'PUT');
  await api('/api/projects', { folderPath: projectDir });
  const projects = await api('/api/sessions/projects');
  const project = projects.projects.find((item) => item.decodedPath === projectDir);
  assert.ok(project?.encodedDir);
  const createdTask = await api('/api/tasks', {
    projectId: project.encodedDir,
    title: 'Linked Session Materialization',
    workflowStatus: 'in_progress',
  });
  const checkout = await api('/api/worktrees', {
    projectDir,
    taskId: createdTask.task.id,
    branchSlug: 'issue-333-linked',
  });
  worktreePath = checkout.worktreePath;
  branchName = checkout.branchName;
  const createdSession = await api('/api/sessions', {
    workDir: worktreePath,
    parentProjectId: project.encodedDir,
    taskId: createdTask.task.id,
    worktreeBranch: branchName,
    providerId: 'codex',
    executionMode: 'gui',
    title: 'Summary-only linked Session',
    hasCustomTitle: true,
  });
  const taskProjection = await api(`/api/tasks?projectId=${encodeURIComponent(project.encodedDir)}`);
  const task = taskProjection.tasks.find((item) => item.id === createdTask.task.id);
  assert.equal(task.sessions[0]?.id, createdSession.sessionId);
  const detail = await api(`/api/sessions/${encodeURIComponent(createdSession.sessionId)}`);
  assert.equal(detail.session.worktreeId, task.worktreeId);
  assert.equal(detail.session.workDir, worktreePath);
  const refreshedProjects = await api('/api/sessions/projects');
  const refreshedProject = refreshedProjects.projects.find((item) => item.encodedDir === project.encodedDir);
  assert.equal(refreshedProject.sessions.some((item) => item.id === createdSession.sessionId), false);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addInitScript((projectId) => {
    localStorage.setItem('ccw:viewMode', 'board');
    localStorage.setItem('ccw:projectViewModes', JSON.stringify({ [projectId]: 'board' }));
    localStorage.setItem('ccw:selectedProjectDir', projectId);
  }, project.encodedDir);
  page = await context.newPage();
  await page.route(`**/api/sessions/${createdSession.sessionId}/messages?*`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ messages: [], pagination: { hasMore: false, nextBeforeBytes: 0 } }),
  }));
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const card = page.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`);
  await card.waitFor({ timeout: 120_000 });
  await card.click();
  await page.getByTestId('kanban-session-peek').waitFor();
  await page.locator('[data-testid="message-input-row"]:visible').waitFor();
  await page.getByTestId('kanban-git-panel-toggle').click();
  await page.locator(`[data-testid="git-panel"][data-worktree-target="${task.worktreeId}"]`).waitFor();
  await page.screenshot({ path: path.join(evidenceDir, 'linked-session-peek.png'), fullPage: true });

  await api('/api/settings', { kanbanSessionOpenMode: 'split' }, 'PUT');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
  await card.waitFor({ timeout: 120_000 });
  await card.click();
  assert.equal(await page.getByTestId('kanban-session-peek').count(), 0);
  await page.locator('[data-testid="message-input-row"]:visible').waitFor();
  await page.locator(`[data-testid="git-panel"][data-worktree-target="${task.worktreeId}"]`).waitFor();
  await page.screenshot({ path: path.join(evidenceDir, 'linked-session-tab.png'), fullPage: true });
  console.log(`Issue 333 linked Session navigation passed; evidence: ${evidenceDir}`);
} catch (error) {
  await page?.screenshot({ path: path.join(evidenceDir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error, logs.join('').slice(-4000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
  if (worktreePath) await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectDir }).catch(() => {});
  if (branchName) await run('git', ['branch', '-D', branchName], { cwd: projectDir }).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
