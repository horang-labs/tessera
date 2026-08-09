import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { startDevServer } from './helpers/dev-server.mjs';

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-git-ladder-'));
const repo = path.join(root, 'work');
const other = path.join(root, 'other');
const remote = path.join(root, 'remote.git');
const artifactDir = path.join(os.homedir(), 'tmp', 'tessera-ticket-313');
const artifact = path.join(artifactDir, 'partial-push-failure.png');
let runtime;
let browser;

async function git(args, cwd = repo) {
  return execFileAsync('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args], { cwd });
}

async function api(pathname, init = {}) {
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
  assert.equal(response.ok, true, `${pathname}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitForAction(page, kind, text) {
  const primary = page.getByTestId('desktop-commit-primary');
  await primary.and(page.locator(`[data-git-action="${kind}"]`)).waitFor({ timeout: 30_000 });
  if (text) await primary.getByText(text).waitFor();
  return primary;
}

async function createSession(title) {
  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: repo,
      parentProjectId: repo,
      providerId: 'claude-code',
      executionMode: 'gui',
      hasCustomTitle: true,
      title,
    }),
  });
  return created.sessionId ?? created.session?.id ?? created.id;
}

try {
  await git(['init', '--bare', '--initial-branch=main', remote], root);
  await git(['init', '--initial-branch=main', repo], root);
  await fs.writeFile(path.join(repo, 'seed.txt'), 'seed\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'seed']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  await git(['checkout', '-b', 'feature/ladder']);
  await git(['push', '-u', 'origin', 'feature/ladder']);
  await git(['config', 'pull.rebase', 'true']);
  await git(['clone', remote, other], root);
  await git(['checkout', 'feature/ladder'], other);
  await fs.writeFile(path.join(other, 'remote.txt'), 'remote\n');
  await git(['add', '.'], other);
  await git(['commit', '-m', 'remote advance'], other);
  await git(['push'], other);
  await git(['fetch']);
  await fs.writeFile(path.join(repo, 'local.txt'), 'local\n');

  runtime = await startDevServer({
    dataDirPrefix: 'tessera-git-ladder-data-',
    env: { TESSERA_ELECTRON_AUTH_BYPASS: '1' },
  });
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ agentEnvironment: 'wsl' }) });
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: repo }) });
  const sessionId = await createSession('desktop ladder');
  const sharedSessionId = await createSession('shared ladder');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-tessera-app-secret': runtime.appSecret },
  });
  await context.addInitScript((project) => localStorage.setItem('ccw:selectedProjectDir', project), repo);
  const page = await context.newPage();
  await page.goto(`${runtime.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();

  await waitForAction(page, 'commit', 'Commit');
  await page.getByTestId('desktop-commit-menu-trigger').click();
  const ids = await page.getByTestId('desktop-commit-action-menu')
    .locator('[data-testid^="git-action-menu-item-"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-testid')?.replace('git-action-menu-item-', '')));
  assert.deepEqual(ids, ['commit', 'commit_push', 'push', 'pull', 'create_pr', 'open_source_control']);
  await page.getByTestId('desktop-commit-menu-trigger').click();

  await page.getByTestId('desktop-commit-primary').click();
  const composer = page.getByTestId('desktop-commit-composer');
  await composer.getByTestId('git-commit-message').fill('local delivery');
  await composer.getByTestId('git-primary-action-button').click();
  await waitForAction(page, 'pull', 'Pull (1)');
  await page.getByTestId(`collection-chat-${sharedSessionId}`).first().click();
  await waitForAction(page, 'pull', 'Pull (1)');
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();
  await page.getByTestId('desktop-commit-primary').click();
  await waitForAction(page, 'push', 'Push (1)');
  await page.getByTestId(`collection-chat-${sharedSessionId}`).first().click();
  await waitForAction(page, 'push', 'Push (1)');
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();
  assert.equal((await git(['config', 'pull.rebase'])).stdout.trim(), 'true');

  await fs.writeFile(path.join(repo, 'compound.txt'), 'compound\n');
  await api(`/api/sessions/${sessionId}/refresh-git`, { method: 'POST' });
  await waitForAction(page, 'commit', 'Commit');
  await page.getByTestId('desktop-commit-primary').click();
  await composer.getByTestId('git-commit-message').fill('compound delivery');
  await fs.mkdir(path.join(repo, '.git', 'hooks'), { recursive: true });
  const hook = path.join(repo, '.git', 'hooks', 'pre-push');
  await fs.writeFile(hook, '#!/bin/sh\necho push blocked for retry >&2\nexit 1\n', { mode: 0o755 });
  await page.getByTestId('desktop-commit-menu-trigger').click();
  await page.getByTestId('git-action-menu-item-commit_push').click();

  await page.getByTestId('desktop-git-action-failure').waitFor({ timeout: 30_000 });
  assert.equal((await git(['log', '-1', '--pretty=%s'])).stdout.trim(), 'compound delivery');
  await waitForAction(page, 'push', 'Push (2)');
  await page.getByTestId(`collection-chat-${sharedSessionId}`).first().click();
  await waitForAction(page, 'push', 'Push (2)');
  await page.getByTestId('desktop-git-action-failure').waitFor();
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();
  await page.getByTestId('desktop-git-action-failure').locator('summary').click();
  await page.getByTestId('git-action-failure-summary').getByText(/push blocked for retry/i).waitFor();
  await page.getByTestId('tab-bar-git-toggle').waitFor();
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: artifact });

  await fs.rm(hook);
  await page.getByTestId('desktop-commit-primary').click();
  const blocked = await waitForAction(page, 'create_pr', 'Create PR');
  assert.equal(await blocked.isDisabled(), true);
  await page.getByTestId(`collection-chat-${sharedSessionId}`).first().click();
  const sharedBlocked = await waitForAction(page, 'create_pr', 'Create PR');
  assert.equal(await sharedBlocked.isDisabled(), true);
  assert.equal((await git(['status', '--porcelain'])).stdout.trim(), '');
  console.log(JSON.stringify({ artifact, ladder: ['commit', 'pull', 'push', 'create_pr'], partialFailure: true, sharedOwner: true }));
} finally {
  await browser?.close().catch(() => {});
  await runtime?.stop().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
