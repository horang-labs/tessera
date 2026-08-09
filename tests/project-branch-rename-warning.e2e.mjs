import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const port = Number(process.env.TESSERA_E2E_PORT ?? 34294);
const origin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-rename-warning-e2e-'));
const screenshotPath = process.env.TESSERA_E2E_SCREENSHOT
  ?? path.join(os.tmpdir(), 'tessera-294-branch-rename-warning.png');
const serverOutput = [];
let server;
let browser;

function project(previousBranch, currentBranch) {
  return {
    encodedDir: '/rename-fixture',
    displayName: 'Rename fixture',
    decodedPath: '/rename-fixture',
    displayPath: '/rename-fixture',
    projectWorktree: {
      id: 'wt_rename_fixture',
      path: '/rename-fixture',
      displayPath: '/rename-fixture',
      currentBranch,
    },
    branchRenameWarning: {
      previousBranch,
      currentBranch,
      eventId: `${previousBranch}-to-${currentBranch}`,
    },
    isCurrent: true,
    sessions: [],
    totalSessions: 0,
    countByStatus: {},
    cursorByStatus: {},
    nextCursor: null,
  };
}

async function startServer() {
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_CHILD',
    'TESSERA_APP_ROOT',
    'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB',
    'TESSERA_HOOK_PORT',
    'TESSERA_PANE_TOKEN',
    'TESSERA_SESSION_ID',
  ]) delete env[key];
  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => serverOutput.push(chunk.toString()));
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(serverOutput.join(''));
    try {
      if ((await fetch(`${origin}/api/auth/setup`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${serverOutput.join('')}`);
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
}

try {
  await startServer();
  browser = await chromium.launch({
    headless: process.env.TESSERA_E2E_HEADFUL !== '1',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${origin}/setup`, { waitUntil: 'domcontentloaded' });
  const setup = await page.evaluate(async () => {
    const response = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'rename-warning', password: 'rename-warning' }),
    });
    return { ok: response.ok, text: await response.text() };
  });
  assert.equal(setup.ok, true, setup.text);

  let responseProject = project('main', 'renamed');
  await page.route('**/api/sessions/projects', async (route) => {
    await route.fulfill({ json: { projects: [responseProject] } });
  });
  await page.goto(`${origin}/chat`, { waitUntil: 'domcontentloaded' });

  const warning = page.getByTestId('branch-rename-warning');
  await warning.waitFor({ timeout: 30_000 });
  const warningText = await warning.innerText();
  assert.match(warningText, /main/);
  assert.match(warningText, /renamed/);
  assert.match(warningText, /hidden/i);
  assert.match(warningText, /not (moved|changed)/i);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const expandSidebar = page.getByTestId('tab-bar-sidebar-toggle');
  if (await expandSidebar.count()) await expandSidebar.click();
  await warning.waitFor();
  const dismissBox = await page.getByTestId('branch-rename-warning-dismiss').boundingBox();
  assert.ok(dismissBox && dismissBox.width >= 44 && dismissBox.height >= 44,
    'the phone dismiss control must retain a 44px touch target');
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByTestId('project-worktree-row').click();
  await page.getByRole('button', { name: 'New Session', exact: true }).waitFor();
  await page.getByTestId('branch-rename-warning-dismiss').click();
  assert.equal(await warning.count(), 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('project-worktree-row').waitFor();
  assert.equal(await warning.count(), 0, 'the same warning stays dismissed after reload');

  responseProject = project('renamed', 'renamed-again');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await warning.waitFor();
  assert.match(await warning.innerText(), /renamed-again/);
  console.log(`Rendered rename warning and one-time dismissal passed. Screenshot: ${screenshotPath}`);
} finally {
  await browser?.close();
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
}
