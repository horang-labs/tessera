// A real-browser regression for stale session-history responses stealing focus.
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
const fixtureRoot = await fs.mkdtemp(path.join(os.homedir(), 'tmp', 'tessera-focus-stability-'));
const projectDir = path.join(fixtureRoot, 'project');

let server;
let browser;
let releaseSlowHistory = () => {};

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

async function createSession(title) {
  const result = await api('/api/sessions', {
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
  const sessionId = result.sessionId ?? result.session?.id ?? result.id;
  assert.ok(sessionId, `session response for ${title} carried no id`);
  return sessionId;
}

try {
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main'], { cwd: projectDir });

  server = await startDevServer({
    dataDirPrefix: 'tessera-focus-stability-data-',
    seed: seedBrowserUser,
  });
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl', showRecentWork: false }),
  });
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });

  const slowTitle = 'slow abandoned session';
  const chosenTitle = 'newer chosen session';
  const slowSessionId = await createSession(slowTitle);
  const chosenSessionId = await createSession(chosenTitle);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-tessera-app-secret': server.appSecret },
  });
  await addBrowserAuthCookie(context, server);
  const page = await context.newPage();

  let markSlowHistoryStarted;
  const slowHistoryStarted = new Promise((resolve) => { markSlowHistoryStarted = resolve; });
  let markSlowHistoryFinished;
  const slowHistoryFinished = new Promise((resolve) => { markSlowHistoryFinished = resolve; });
  const slowHistoryGate = new Promise((resolve) => { releaseSlowHistory = resolve; });

  await page.route(
    (url) => url.pathname === `/api/sessions/${slowSessionId}/messages`,
    async (route) => {
      markSlowHistoryStarted();
      await slowHistoryGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: slowSessionId,
          messages: [],
          activeInteractivePrompt: null,
          todoSnapshot: [],
          pagination: { hasMore: false, nextBeforeBytes: 0 },
        }),
      });
      markSlowHistoryFinished();
    },
  );

  await page.goto(`${server.origin}/chat`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 60_000 });
  await page.locator(`[data-testid="project-strip-${projectDir}"]`).click({ timeout: 30_000 });

  const slowRow = page.locator(`[data-session-id="${slowSessionId}"]`).first();
  const chosenRow = page.locator(`[data-session-id="${chosenSessionId}"]`).first();
  await slowRow.waitFor({ state: 'visible', timeout: 30_000 });
  await chosenRow.waitFor({ state: 'visible', timeout: 30_000 });

  await slowRow.click();
  await slowHistoryStarted;
  await chosenRow.click();

  const activeTab = page.locator('[role="tab"][aria-selected="true"]');
  await activeTab.filter({ hasText: chosenTitle }).waitFor({ timeout: 30_000 });

  releaseSlowHistory();
  await slowHistoryFinished;
  await page.waitForTimeout(250);

  assert.match(
    await activeTab.innerText(),
    new RegExp(chosenTitle),
    'the late history response switched the active tab back to the abandoned session',
  );
  assert.equal(
    await page.locator(`[data-session-id="${chosenSessionId}"]`).first().count(),
    1,
  );

  console.log(`Late history for ${slowSessionId} did not steal focus from ${chosenSessionId}.`);
} finally {
  releaseSlowHistory();
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await fs.rm(server?.dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}
