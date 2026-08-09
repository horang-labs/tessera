/** Issue #312: dirty desktop worktrees get a compact, worktree-owned commit path. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startDevServer } from './helpers/dev-server.mjs';

const run = promisify(execFile);
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-desktop-commit-'));
const repo = path.join(fixtureRoot, 'repo');
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.homedir(), 'tmp', 'tessera-ticket-312');
const artifact = path.join(artifactDir, 'compact-composer.png');
let runtime;
let browser;

async function git(args) {
  return run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args], { cwd: repo });
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

try {
  await fs.mkdir(repo, { recursive: true });
  await git(['init', '-b', 'main']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'seed a\n');
  await fs.writeFile(path.join(repo, 'b.txt'), 'seed b\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'seed']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'dirty a\nextra a\n');
  await fs.writeFile(path.join(repo, 'b.txt'), 'dirty b\n');
  await fs.mkdir(path.join(repo, 'nested'));

  runtime = await startDevServer({
    dataDirPrefix: 'tessera-desktop-commit-data-',
    env: { TESSERA_ELECTRON_AUTH_BYPASS: '1' },
  });
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ folderPath: repo }) });
  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: repo,
      parentProjectId: repo,
      providerId: 'claude-code',
      executionMode: 'gui',
      hasCustomTitle: true,
      title: 'desktop commit',
    }),
  });
  const sessionId = created.sessionId ?? created.session?.id ?? created.id;
  const secondCreated = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: path.join(repo, 'nested'),
      parentProjectId: repo,
      providerId: 'claude-code',
      executionMode: 'gui',
      hasCustomTitle: true,
      title: 'same worktree second',
    }),
  });
  const secondSessionId = secondCreated.sessionId ?? secondCreated.session?.id ?? secondCreated.id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-tessera-app-secret': runtime.appSecret },
  });
  await context.addInitScript((project) => {
    localStorage.setItem('ccw:selectedProjectDir', project);
  }, repo);
  const page = await context.newPage();
  await page.goto(`${runtime.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();

  const control = page.getByTestId('desktop-commit-control');
  await control.waitFor({ timeout: 60_000 });
  await page.getByTestId('desktop-commit-primary').waitFor();
  await page.getByRole('button', { name: /more git actions for repo/i }).waitFor();
  await page.getByTestId('desktop-commit-primary').click();
  await page.getByRole('button', { name: /more git actions for repo/i }).click();
  await page.getByTestId('desktop-commit-composer').waitFor({ state: 'detached' });
  await page.getByTestId('desktop-commit-action-menu').waitFor();
  await page.getByRole('button', { name: /more git actions for repo/i }).click();
  await page.getByRole('button', { name: /open changed files: 3 additions, 2 deletions/i }).click();
  await page.getByTestId('git-panel').waitFor();
  await page.getByText('Changed files', { exact: true }).waitFor();
  await page.getByTestId('tab-bar-git-toggle').click();

  await page.getByTestId('desktop-commit-primary').click();
  const composer = page.getByTestId('desktop-commit-composer');
  await composer.waitFor();
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim().length, 40);
  await composer.getByTestId('git-commit-message').fill('shared compact draft');
  await composer.getByTestId('desktop-commit-file-checkbox-a.txt').uncheck();
  await composer.getByText(/1 selected/).waitFor();
  await page.getByTestId('desktop-commit-diff-stat').getByText('+3').waitFor();
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: artifact });

  await page.getByTestId(`collection-chat-${secondSessionId}`).first().click();
  await page.getByTestId('desktop-commit-primary').click();
  assert.equal(await composer.getByTestId('git-commit-message').inputValue(), 'shared compact draft');
  assert.equal(await composer.getByTestId('desktop-commit-file-checkbox-a.txt').isChecked(), false);
  await composer.getByTestId('git-commit-message').fill('shared from second');
  await page.getByTestId(`collection-chat-${sessionId}`).first().click();
  await page.getByTestId('desktop-commit-primary').click();
  assert.equal(await composer.getByTestId('git-commit-message').inputValue(), 'shared from second');

  await composer.getByRole('button', { name: /review files/i }).click();
  await page.getByTestId('git-panel').waitFor();
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'shared from second');
  assert.equal(await page.getByTestId('git-commit-file-checkbox-a.txt').isChecked(), false);
  await page.getByTestId('git-commit-message').fill('commit b only');
  await page.getByTestId('tab-bar-git-toggle').click();
  await page.getByTestId('desktop-commit-primary').click();
  assert.equal(await composer.getByTestId('git-commit-message').inputValue(), 'commit b only');

  await page.route('**/git/commit-message', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'generator offline' }),
  }));
  await composer.getByTestId('git-commit-generate-button').click();
  await composer.getByTestId('git-commit-generate-error').waitFor();
  await composer.getByTestId('git-commit-message').fill('manual still works');
  await page.unroute('**/git/commit-message');

  let commitRequest;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/sessions/${sessionId}/git/action`)) {
      commitRequest = request.postDataJSON();
    }
  });
  await composer.getByTestId('git-primary-action-button').click();
  await composer.waitFor({ state: 'detached' });
  assert.deepEqual(commitRequest, { action: 'commit', message: 'manual still works', files: ['b.txt'] });
  assert.equal((await git(['log', '-1', '--pretty=%s'])).stdout.trim(), 'manual still works');
  assert.equal((await git(['status', '--short'])).stdout.trim(), 'M a.txt');

  await page.getByTestId('desktop-commit-primary').click();
  assert.equal(await composer.getByTestId('git-commit-message').inputValue(), '');
  assert.equal(await composer.getByTestId('desktop-commit-file-checkbox-a.txt').isChecked(), true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByTestId('desktop-commit-primary').waitFor();
  await page.getByTestId('tab-bar-git-toggle').waitFor();
  assert.equal(await page.getByTestId('desktop-commit-diff-stat').isVisible(), false);
  console.log(JSON.stringify({ artifact, committed: ['b.txt'], mediumWidth: 900 }));
} finally {
  await browser?.close().catch(() => {});
  await runtime?.stop().catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
