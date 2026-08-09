/** Issue #314: conflicts navigate to focused, retryable recovery. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startDevServer } from './helpers/dev-server.mjs';

const run = promisify(execFile);
const externalCdp = process.env.TESSERA_E2E_CDP_URL ?? null;
function filesystemPath(value) {
  if (!externalCdp || process.platform !== 'win32' || !value?.startsWith('/')) return value;
  const distro = process.env.TESSERA_E2E_WSL_DISTRO ?? 'Ubuntu-24.04';
  return `\\\\wsl.localhost\\${distro}${value.replaceAll('/', '\\')}`;
}
const fixtureRoot = externalCdp
  ? filesystemPath(process.env.TESSERA_E2E_FIXTURE_FS_ROOT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-conflict-recovery-'));
assert.ok(fixtureRoot, 'external Electron runs require TESSERA_E2E_FIXTURE_FS_ROOT');
const repo = path.join(fixtureRoot, 'repo');
const repoAgentPath = process.env.TESSERA_E2E_REPO_AGENT_PATH ?? repo;
const artifactDir = filesystemPath(process.env.TESSERA_E2E_ARTIFACT_DIR)
  ?? path.join(os.homedir(), 'tmp', 'tessera-ticket-314');
const artifact = path.join(artifactDir, 'conflict-recovery.png');
let runtime;
let browser;

async function git(args) {
  return run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args], { cwd: repo });
}

async function api(pathname, init = {}, expectedStatus = 200) {
  const response = await fetch(`${runtime.origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': runtime.appSecret,
      origin: runtime.origin,
      ...init.headers,
    },
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${pathname}: ${text}`);
  return text ? JSON.parse(text) : null;
}

try {
  if (!externalCdp) {
    await fs.mkdir(repo, { recursive: true });
    await git(['init', '-b', 'main']);
    await fs.writeFile(path.join(repo, 'conflict.txt'), 'base\n');
    await fs.writeFile(path.join(repo, 'delete-modify.txt'), 'base\n');
    await fs.writeFile(path.join(repo, 'note.txt'), 'base\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'base']);
    await git(['checkout', '-b', 'other']);
    await fs.writeFile(path.join(repo, 'conflict.txt'), 'other\n');
    await fs.writeFile(path.join(repo, 'delete-modify.txt'), 'other\n');
    await git(['commit', '-am', 'other changes']);
    await git(['checkout', 'main']);
    await fs.writeFile(path.join(repo, 'conflict.txt'), 'main\n');
    await fs.rm(path.join(repo, 'delete-modify.txt'));
    await git(['commit', '-am', 'main changes']);
    await fs.writeFile(path.join(repo, 'note.txt'), 'ordinary dirty change\n');
    await git(['merge', 'other']).catch(() => null);
    runtime = await startDevServer({
      dataDirPrefix: 'tessera-conflict-recovery-data-',
      env: { TESSERA_ELECTRON_AUTH_BYPASS: '1' },
    });
  } else {
    runtime = {
      origin: process.env.TESSERA_E2E_ORIGIN,
      appSecret: process.env.TESSERA_E2E_APP_SECRET,
    };
    assert.ok(runtime.origin && runtime.appSecret, 'external Electron origin and secret are required');
  }
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: repoAgentPath }) });
  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: repoAgentPath,
      parentProjectId: repoAgentPath,
      providerId: 'claude-code',
      executionMode: 'gui',
      hasCustomTitle: true,
      title: 'conflict recovery',
    }),
  }, 201);
  const sessionId = created.sessionId ?? created.session?.id ?? created.id;

  browser = externalCdp
    ? await chromium.connectOverCDP(externalCdp)
    : await chromium.launch({ headless: true });
  const context = externalCdp
    ? browser.contexts()[0]
    : await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'x-tessera-app-secret': runtime.appSecret },
    });
  const page = externalCdp ? context.pages()[0] : await context.newPage();
  await page.goto(`${runtime.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.evaluate((project) => {
    if (window.electronAPI?.isElectron && window.electronAPI.uiStorageSetItem) {
      window.electronAPI.uiStorageSetItem('ccw:selectedProjectDir', project);
    } else {
      localStorage.setItem('ccw:selectedProjectDir', project);
    }
  }, repoAgentPath);
  await page.reload({ waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();

  if (externalCdp) {
    const firstRead = await Promise.race([
      page.getByTestId('desktop-conflict-control').waitFor({ timeout: 15_000 }).then(() => 'ready'),
      page.getByText('Git panel unavailable', { exact: true }).waitFor({ timeout: 15_000 }).then(() => 'retry'),
    ]);
    if (firstRead === 'retry') {
      await page.reload({ waitUntil: 'load', timeout: 120_000 });
      await page.getByTestId(`collection-chat-${sessionId}`).first().click();
    }
  }
  await page.getByTestId('desktop-conflict-control').waitFor({ timeout: 60_000 });
  assert.equal(await page.getByTestId('desktop-commit-control').count(), 0);
  await page.getByTestId('desktop-conflict-primary').click();
  const recovery = page.getByTestId('git-conflict-recovery');
  await recovery.waitFor();
  assert.equal(await recovery.evaluate((node) => document.activeElement === node), true);
  await recovery.getByText('Merge in progress', { exact: true }).waitFor();
  assert.equal(await recovery.getByTestId('git-conflict-file-conflict.txt').count(), 1);
  assert.equal(await recovery.getByTestId('git-conflict-file-delete-modify.txt').count(), 1);
  assert.equal(await recovery.getByText('note.txt', { exact: true }).count(), 0);

  const panel = page.getByTestId('git-panel');
  await panel.getByTestId('git-action-menu-trigger').click();
  assert.equal(await panel.getByTestId('git-action-menu-item-commit').isDisabled(), true);
  assert.equal(await panel.getByTestId('git-action-menu-item-commit_push').isDisabled(), true);
  assert.equal(await panel.getByTestId('git-action-menu-item-pull').isDisabled(), true);
  const abort = panel.getByTestId('git-action-menu-item-abort');
  assert.equal(await abort.getAttribute('data-git-action'), 'abort');
  assert.match(await abort.innerText(), /Abort merge/);
  await panel.getByTestId('git-action-menu-trigger').click();

  const beforeReview = await fs.readFile(path.join(repo, 'conflict.txt'), 'utf8');
  await recovery.getByTestId('git-conflict-file-conflict.txt').click();
  await page.getByText('Diff', { exact: true }).first().waitFor();
  assert.equal(await fs.readFile(path.join(repo, 'conflict.txt'), 'utf8'), beforeReview);
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: artifact });

  await page.getByTestId(`collection-chat-${sessionId}`).first().click();
  await page.getByTestId('git-conflict-recovery').waitFor();
  await fs.writeFile(path.join(repo, '.git', 'index.lock'), 'locked by e2e');
  await panel.getByTestId('git-action-menu-trigger').click();
  await panel.getByTestId('git-action-menu-item-abort').click();
  await panel.getByTestId('git-action-failure-banner').waitFor();
  assert.equal(await fs.stat(path.join(repo, '.git', 'MERGE_HEAD')).then(() => true), true);
  await fs.rm(path.join(repo, '.git', 'index.lock'));
  await panel.getByTestId('git-action-menu-trigger').click();
  await panel.getByTestId('git-action-menu-item-abort').click();
  await page.getByTestId('desktop-commit-control').waitFor({ timeout: 30_000 });
  await assert.rejects(fs.stat(path.join(repo, '.git', 'MERGE_HEAD')));
  assert.equal(await fs.readFile(path.join(repo, 'note.txt'), 'utf8'), 'ordinary dirty change\n');

  const stale = await api(
    `/api/sessions/${sessionId}/git/action`,
    { method: 'POST', body: JSON.stringify({ action: 'abort' }) },
    409,
  );
  assert.equal(stale.error?.code ?? stale.code, 'no_conflict_in_progress');
  console.log(JSON.stringify({ artifact, operation: 'merge', unresolved: 2, retrySucceeded: true }));
} finally {
  if (!externalCdp) await browser?.close().catch(() => {});
  await runtime?.stop?.().catch(() => {});
  if (!externalCdp) await fs.rm(fixtureRoot, { recursive: true, force: true });
}

// The CDP websocket would otherwise keep Windows Node alive. All assertions and
// file writes are awaited above; exit without sending Browser.close to Electron.
if (externalCdp) process.exit(0);
