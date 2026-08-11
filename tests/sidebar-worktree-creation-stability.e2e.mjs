// A real-browser regression for Worktree creation layout stability in the sidebar.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import {
  addBrowserAuthCookie,
  seedBrowserUser,
  startDevServer,
} from './helpers/dev-server.mjs';

const run = promisify(execFile);
const fixtureRoot = await fs.mkdtemp(path.join(os.homedir(), 'tmp', 'tessera-sidebar-stability-'));
const projectName = `sidebar-stability-${path.basename(fixtureRoot).slice(-6)}`;
const projectDir = path.join(fixtureRoot, projectName);
const managedWorktreeDir = path.join(os.homedir(), '.tessera', 'worktrees', projectName);

let server;
let browser;
let page;

async function api(pathname, init) {
  const response = await fetch(`${server.origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': server.appSecret,
      origin: server.origin,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${pathname}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function prepareFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  const git = (args) => run('git', [
    '-c', 'user.email=e2e@tessera.test',
    '-c', 'user.name=Tessera E2E',
    ...args,
  ], { cwd: projectDir });
  await git(['init', '-b', 'main']);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# sidebar stability fixture\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial']);
}

async function configureProject() {
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      agentEnvironment: 'wsl',
      agentExecutionMode: 'pty',
      defaultNewSessionKind: 'task',
      showRecentWork: false,
      showProviderIcons: true,
    }),
  });
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });
  for (const phase of ['before', 'after']) {
    await api('/api/projects/preparation-script', {
      method: 'PUT',
      body: JSON.stringify({
        projectId: projectDir,
        phase,
        preparationScript: `echo ${phase}-start\nsleep 0.45\necho ${phase}-done`,
      }),
    });
  }
}

async function openProject() {
  await page.goto(`${server.origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 60_000 });
  await page.locator(`[data-testid="project-strip-${projectDir}"]`).click({ timeout: 30_000 });
  await page.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 30_000 });
}

async function startTitlePositionSampler(title) {
  await page.evaluate((targetTitle) => {
    const state = { stopped: false, positions: [] };
    const sample = () => {
      const row = [...document.querySelectorAll('.task-item-container > [data-testid^="collection-task-"]')]
        .find((candidate) => candidate.textContent?.includes(targetTitle));
      const titleContainer = row?.querySelector('.min-w-0.flex-1');
      const left = titleContainer?.getBoundingClientRect().left;
      if (left !== undefined) {
        const rounded = Math.round(left * 10) / 10;
        if (state.positions.at(-1) !== rounded) state.positions.push(rounded);
      }
      if (!state.stopped) requestAnimationFrame(sample);
    };
    window.__sidebarTitlePositionSampler = state;
    requestAnimationFrame(sample);
  }, title);
}

async function stopTitlePositionSampler() {
  return page.evaluate(() => {
    window.__sidebarTitlePositionSampler.stopped = true;
    return window.__sidebarTitlePositionSampler.positions;
  });
}

async function submitWorktree(title) {
  await page.getByTestId('empty-panel-mode-task').click({ timeout: 30_000 });
  await page.getByTestId('empty-panel-task-title-input').fill(title);
  const slug = page.getByTestId('empty-panel-branch-slug-input');
  if (await slug.count()) await slug.fill(title);
  await page.getByTestId('empty-panel-create-session').click();
}

try {
  await prepareFixture();
  server = await startDevServer({
    dataDirPrefix: 'tessera-sidebar-stability-data-',
    seed: seedBrowserUser,
  });
  await configureProject();

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    extraHTTPHeaders: { 'x-tessera-app-secret': server.appSecret },
  });
  await addBrowserAuthCookie(context, server);
  page = await context.newPage();
  await openProject();

  const title = 'stable-sidebar-worktree';
  await startTitlePositionSampler(title);
  await submitWorktree(title);

  const taskRow = page.locator('.task-item-container > [data-testid^="collection-task-"]')
    .filter({ hasText: title });
  await taskRow.waitFor({ state: 'visible', timeout: 30_000 });
  const preparationBadge = taskRow.getByTestId('task-preparation-badge');
  await preparationBadge.waitFor({ state: 'visible', timeout: 30_000 });
  await preparationBadge.waitFor({ state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(250);

  const titlePositions = await stopTitlePositionSampler();
  assert.ok(titlePositions.length > 0, 'the new Worktree title was never rendered in the sidebar');
  assert.equal(
    titlePositions.length,
    1,
    `new Worktree title shifted horizontally while creation state changed: ${titlePositions.join(' -> ')}`,
  );
  console.log(`Sidebar Worktree title stayed fixed at x=${titlePositions[0]}px during creation.`);
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await fs.rm(server?.dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(managedWorktreeDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}
