/** Issue #311: the visible Git panel consumes one delivery owner per worktree. */
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
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-git-owner-'));
const sharedRepo = path.join(fixtureRoot, 'shared');
const otherRepo = path.join(fixtureRoot, 'other');
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.homedir(), 'tmp', 'tessera-ticket-311');
const artifact = path.join(artifactDir, 'shared-failure.png');
let runtime;
let browser;

async function git(args, cwd) {
  return run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args], { cwd });
}

async function initRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(['init', '-b', 'main'], dir);
  await fs.writeFile(path.join(dir, 'a.txt'), 'seed a\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'seed b\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'seed'], dir);
  await fs.writeFile(path.join(dir, 'a.txt'), 'dirty a\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'dirty b\n');
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

async function createSession(workDir, title) {
  const result = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir,
      parentProjectId: sharedRepo,
      providerId: 'claude-code',
      executionMode: 'gui',
      hasCustomTitle: true,
      title,
    }),
  });
  return result.sessionId ?? result.session?.id ?? result.id;
}

async function openSession(page, id) {
  await page.getByTestId(`collection-chat-${id}`).first().click();
  await page.waitForResponse((response) =>
    response.url().endsWith(`/api/sessions/${encodeURIComponent(id)}/git`),
  ).catch(() => {});
}

async function openPanel(page) {
  if (await page.getByTestId('git-panel').count() === 0) {
    await page.getByTestId('tab-bar-git-toggle').click();
  }
  await page.getByTestId('git-commit-message').waitFor();
}

try {
  await initRepo(sharedRepo);
  await initRepo(otherRepo);
  await fs.mkdir(path.join(sharedRepo, 'nested'));
  runtime = await startDevServer({
    dataDirPrefix: 'tessera-git-owner-data-',
    env: { TESSERA_ELECTRON_AUTH_BYPASS: '1' },
    seed: seedBrowserUser,
  });
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: sharedRepo }),
  });
  const first = await createSession(sharedRepo, 'shared one');
  const second = await createSession(path.join(sharedRepo, 'nested'), 'shared two');
  const late = await createSession(sharedRepo, 'shared late');
  const outsider = await createSession(otherRepo, 'other tree');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'x-tessera-app-secret': runtime.appSecret },
  });
  await addBrowserAuthCookie(context, runtime);
  await context.addInitScript((project) => {
    localStorage.setItem('ccw:selectedProjectDir', project);
  }, sharedRepo);
  const page = await context.newPage();
  await page.goto(`${runtime.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId(`collection-chat-${first}`).first().waitFor({ timeout: 60_000 });

  await openSession(page, first);
  await openPanel(page);
  await page.getByTestId('git-commit-message').fill('shared draft');
  await page.getByTestId('git-commit-file-checkbox-a.txt').uncheck();
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'shared draft');
  await page.getByTestId('tab-bar-git-toggle').click();
  await page.getByTestId('git-panel').waitFor({ state: 'detached' });
  await openPanel(page);
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'shared draft');
  assert.equal(await page.getByTestId('git-commit-file-checkbox-a.txt').isChecked(), false);

  await openSession(page, second);
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'shared draft');
  await page.getByTestId('git-commit-message').fill('updated by second');

  let finishAction;
  await page.route('**/api/sessions/*/git/action', async (route) => {
    await new Promise((resolve) => { finishAction = resolve; });
    await route.fulfill({ status: 200, json: {
      ok: false,
      failure: { kind: 'hook_rejected', message: 'hook refused', stderr: 'hook refused', stdout: '', exitCode: 1, changedFiles: [] },
    } });
  });
  await page.getByTestId('git-primary-action-button').click();
  await page.getByTestId('git-commit-message').waitFor({ state: 'visible' });
  await assert.rejects(page.getByTestId('git-commit-message').fill('locked'), /disabled/);

  let finishSnapshot;
  await page.route(`**/api/sessions/${late}/git`, async (route) => {
    await new Promise((resolve) => { finishSnapshot = resolve; });
    await route.continue();
  });
  await page.getByTestId(`collection-chat-${late}`).first().click();
  for (let tries = 0; tries < 100 && !finishSnapshot; tries += 1) {
    await page.waitForTimeout(50);
  }
  assert.ok(finishSnapshot, 'the late session should request its first Git snapshot');
  await page.getByTestId('git-commit-message').fill('typed before identity');
  finishSnapshot();
  await page.getByTestId('git-commit-file-checkbox-a.txt').waitFor();
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'typed before identity');
  assert.equal(await page.getByTestId('git-commit-file-checkbox-a.txt').isChecked(), false);
  assert.equal(await page.getByTestId('git-commit-message').isEnabled(), false);

  await openSession(page, outsider);
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), '');
  assert.equal(await page.getByTestId('git-commit-message').isEnabled(), true);
  await openSession(page, first);
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'typed before identity');
  assert.equal(await page.getByTestId('git-commit-message').isEnabled(), false);

  finishAction();
  await page.getByTestId('desktop-git-action-failure').waitFor();
  await page.getByTestId('git-panel').getByTestId('git-action-failure-banner').waitFor();
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: artifact });
  await page.getByTestId('tab-bar-git-toggle').click();
  await openPanel(page);
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), 'typed before identity');
  await page.getByTestId('git-panel').getByTestId('git-action-failure-banner').waitFor();
  await openSession(page, outsider);
  assert.equal(await page.getByTestId('desktop-git-action-failure').count(), 0);
  assert.equal(await page.getByTestId('git-panel').getByTestId('git-action-failure-banner').count(), 0);
  await openSession(page, first);

  await git(['restore', 'a.txt', 'b.txt'], sharedRepo);
  await page.waitForTimeout(6_000);
  await fs.writeFile(path.join(sharedRepo, 'a.txt'), 'new change\n');
  await page.waitForTimeout(6_000);
  assert.equal(await page.getByTestId('git-commit-message').inputValue(), '');
  assert.equal(await page.getByTestId('git-commit-file-checkbox-a.txt').isChecked(), true);
  console.log(JSON.stringify({ artifact, sharedDraft: true, isolatedPending: true, cleanReset: true }));
} finally {
  await browser?.close().catch(() => {});
  await runtime?.stop().catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
