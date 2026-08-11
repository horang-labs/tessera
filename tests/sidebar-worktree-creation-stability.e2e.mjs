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

async function openRightPanel() {
  await page.getByRole('button', {
    name: /Open right Git panel|오른쪽 Git 패널 열기/,
  }).click({ timeout: 30_000 });
  await page.getByTestId('git-panel').waitFor({ state: 'visible', timeout: 30_000 });
}

async function startRightPanelSampler() {
  await page.evaluate(() => {
    window.__sentWebSocketMessages = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function captureWebSocketSend(payload) {
      if (typeof payload === 'string') window.__sentWebSocketMessages.push(payload);
      return originalSend.call(this, payload);
    };
    const state = {
      stopped: false,
      loadingTransitions: 0,
      readingLogTransitions: 0,
      targetTransitions: [],
      lastLoading: false,
      lastReadingLog: false,
      lastTarget: null,
    };
    const sample = () => {
      const panel = document.querySelector('[data-testid="git-panel"]');
      const text = panel?.textContent ?? '';
      const loading = text.includes('Loading git surface…');
      const readingLog = text.includes('Reading the log...') || text.includes('로그를 불러오는 중...');
      const target = panel
        ? `${panel.getAttribute('data-session-target') ?? ''}|${panel.getAttribute('data-worktree-target') ?? ''}`
        : 'detached';

      if (loading && !state.lastLoading) state.loadingTransitions += 1;
      if (readingLog && !state.lastReadingLog) state.readingLogTransitions += 1;
      if (target !== state.lastTarget) state.targetTransitions.push(target);

      state.lastLoading = loading;
      state.lastReadingLog = readingLog;
      state.lastTarget = target;
      if (!state.stopped) requestAnimationFrame(sample);
    };
    window.__rightPanelSampler = state;
    requestAnimationFrame(sample);
  });
}

async function stopRightPanelSampler() {
  return page.evaluate(() => {
    window.__rightPanelSampler.stopped = true;
    return window.__rightPanelSampler;
  });
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

async function startAllProjectsLoadingSampler(sectionTestId) {
  await page.evaluate((testId) => {
    const state = { stopped: false, transitions: 0, lastLoading: false };
    const sample = () => {
      const section = document.querySelector(`[data-testid="${CSS.escape(testId)}"]`);
      const loading = [...(section?.querySelectorAll('div') ?? [])].some(
        (element) => element.children.length === 0 && element.textContent?.trim() === 'Loading...',
      );
      if (loading && !state.lastLoading) state.transitions += 1;
      state.lastLoading = loading;
      if (!state.stopped) requestAnimationFrame(sample);
    };
    window.__allProjectsLoadingSampler = state;
    requestAnimationFrame(sample);
  }, sectionTestId);
}

async function stopAllProjectsLoadingSampler() {
  return page.evaluate(() => {
    window.__allProjectsLoadingSampler.stopped = true;
    return window.__allProjectsLoadingSampler.transitions;
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
  await openRightPanel();

  const title = 'stable-sidebar-worktree';
  await startTitlePositionSampler(title);
  await startRightPanelSampler();
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
  const rightPanel = await stopRightPanelSampler();

  await taskRow.hover();
  const stopButton = taskRow.locator('[data-testid^="collection-task-quick-stop-"]');
  await stopButton.waitFor({ state: 'visible', timeout: 30_000 });
  const sessionId = await taskRow.getAttribute('data-session-id');
  assert.ok(sessionId, 'the created Worktree task did not expose its Session ID');
  await stopButton.click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid^="collection-task-quick-stop-"]')
      ?.getAttribute('title') === 'Click again to stop process'
  ));
  await stopButton.click();
  await stopButton.waitFor({ state: 'detached', timeout: 10_000 });
  const sentStopMessages = await page.evaluate(() => window.__sentWebSocketMessages
    .map((payload) => {
      try { return JSON.parse(payload); } catch { return null; }
    })
    .filter((message) => message?.type === 'stop_session'));
  assert.equal(sentStopMessages.length, 1, 'the stop control did not send exactly one stop request');
  assert.equal(sentStopMessages[0].sessionId, sessionId, 'the stop control targeted the Task instead of its Session');

  assert.equal(
    rightPanel.loadingTransitions,
    0,
    `right Git panel flashed its loading surface during Worktree creation; targets: ${rightPanel.targetTransitions.join(' -> ')}`,
  );

  await page.getByTestId('project-strip-all').click();
  const allProjectsSectionTestId = `all-project-section-${projectDir}`;
  const allProjectsSection = page.getByTestId(allProjectsSectionTestId);
  await allProjectsSection.waitFor({ state: 'visible', timeout: 30_000 });
  await allProjectsSection.locator(':scope > div').first().click();
  await allProjectsSection.getByText('Loading...', { exact: true }).waitFor({ state: 'detached' });
  await startAllProjectsLoadingSampler(allProjectsSectionTestId);

  const refreshTitle = 'stable-all-projects-refresh';
  const taskResult = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectDir, title: refreshTitle }),
  });
  await api('/api/worktrees', {
    method: 'POST',
    body: JSON.stringify({
      projectDir,
      branchSlug: refreshTitle,
      source: { mode: 'branch-off', baseRef: null },
      taskId: taskResult.task.id,
    }),
  });
  const refreshTaskRow = allProjectsSection.locator('.task-item-container').filter({ hasText: refreshTitle });
  await refreshTaskRow.waitFor({ state: 'visible', timeout: 30_000 });
  const refreshPreparationBadge = refreshTaskRow.getByTestId('task-preparation-badge');
  await refreshPreparationBadge.waitFor({ state: 'visible', timeout: 30_000 });
  await refreshPreparationBadge.waitFor({ state: 'detached', timeout: 30_000 });
  await page.waitForTimeout(250);
  assert.equal(
    await stopAllProjectsLoadingSampler(),
    0,
    'All Projects replaced its cached sidebar rows with Loading... during Worktree refreshes',
  );

  console.log(`Sidebar Worktree title stayed fixed at x=${titlePositions[0]}px during creation.`);
  console.log(`Right panel targets: ${rightPanel.targetTransitions.join(' -> ')}`);
} finally {
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await fs.rm(server?.dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(managedWorktreeDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}
