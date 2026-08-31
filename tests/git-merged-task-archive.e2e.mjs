import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import {
  addBrowserAuthCookie,
  seedBrowserUser,
  startDevServer,
} from './helpers/dev-server.mjs';

const run = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-merged-archive-'));
const repo = path.join(root, 'work');
const remote = path.join(root, 'remote.git');
const fakeBin = path.join(root, 'fake-bin');
const zdotDir = path.join(root, 'zdot');
const ghStatePath = path.join(root, 'gh-pr-state.json');
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(
    os.homedir(),
    'tmp',
    'tessera-e2e-evidence',
    `merged-pr-archive-${new Date().toISOString().replaceAll(':', '-')}`,
  );
const evidence = { artifactDir, passed: false, steps: [] };
let runtime;
let browser;
let page;

async function git(args, cwd = repo) {
  return run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args], {
    cwd,
  });
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

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function readTask(taskId) {
  return (await api(`/api/tasks/${taskId}`)).task;
}

async function waitForTaskState(taskId, workflowStatus, prState) {
  return waitFor(`Task ${taskId} to become ${workflowStatus}/${prState}`, async () => {
    const task = await readTask(taskId);
    return task.workflowStatus === workflowStatus && task.prStatus?.state === prState
      ? task
      : null;
  });
}

async function writeGhState(state, headRefOid) {
  const merged = state === 'MERGED';
  await fs.writeFile(ghStatePath, JSON.stringify([{
    number: 816,
    state,
    url: 'https://github.com/horang-labs/tessera/pull/816',
    mergedAt: merged ? '2026-08-16T00:00:00.000Z' : null,
    updatedAt: merged ? '2026-08-16T00:00:00.000Z' : '2026-08-15T00:00:00.000Z',
    headRefName: 'feature/merged',
    headRefOid,
  }], null, 2));
}

async function capture(name, details = {}) {
  const filename = `${String(evidence.steps.length).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(artifactDir, filename), fullPage: true });
  evidence.steps.push({ name, screenshot: filename, ...details });
}

async function prepareFakeGithubCli() {
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(zdotDir, { recursive: true });
  const fakeGh = path.join(fakeBin, 'gh');
  const fakeSsh = path.join(fakeBin, 'ssh');
  await fs.writeFile(fakeGh, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.80.0 (e2e)"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  /bin/cat "$TESSERA_E2E_GH_STATE"
  exit 0
fi
echo "unexpected fake gh invocation: $*" >&2
exit 2
`);
  await fs.writeFile(fakeSsh, `#!/bin/sh
exec /usr/bin/git-upload-pack "$TESSERA_E2E_REMOTE"
`);
  await fs.chmod(fakeGh, 0o755);
  await fs.chmod(fakeSsh, 0o755);
  await fs.writeFile(
    path.join(zdotDir, '.zshenv'),
    'export PATH="$TESSERA_E2E_FAKE_BIN:/usr/bin:/bin"\n',
  );
  return { fakeSsh };
}

try {
  await fs.mkdir(artifactDir, { recursive: true });
  const { fakeSsh } = await prepareFakeGithubCli();
  await git(['init', '--bare', '--initial-branch=main', remote], root);
  await git(['init', '--initial-branch=main', repo], root);
  await fs.writeFile(path.join(repo, 'seed.txt'), 'seed\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'seed']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  await git(['checkout', '-b', 'feature/merged']);
  await git(['push', '-u', 'origin', 'feature/merged']);
  const headRefOid = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeGhState('OPEN', headRefOid);
  // Keep the advertised URL GitHub-shaped while the e2e-only SSH command serves
  // the local bare repository for `git ls-remote`.
  await git(['remote', 'set-url', 'origin', 'git@github.com:horang-labs/tessera.git']);

  runtime = await startDevServer({
    dataDirPrefix: 'tessera-merged-archive-data-',
    seed: seedBrowserUser,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: zdotDir,
      GIT_SSH_COMMAND: fakeSsh,
      TESSERA_E2E_FAKE_BIN: fakeBin,
      TESSERA_E2E_GH_STATE: ghStatePath,
      TESSERA_E2E_REMOTE: remote,
    },
  });
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: repo }),
  });
  const createdTask = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      projectId: repo,
      title: 'Merged PR lifecycle',
      workflowStatus: 'todo',
      worktreeBranch: 'feature/merged',
    }),
  });
  const task = createdTask.task;
  assert.ok(task?.id);
  const createdTaskSession = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: repo,
      parentProjectId: repo,
      taskId: task.id,
      worktreeBranch: 'feature/merged',
      providerId: 'claude-code',
      executionMode: 'gui',
      title: 'Merged PR lifecycle Session',
      hasCustomTitle: true,
    }),
  });
  const taskSessionId = createdTaskSession.sessionId ?? createdTaskSession.session?.id;
  assert.ok(taskSessionId);
  const createdStandalone = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: repo,
      parentProjectId: repo,
      providerId: 'claude-code',
      executionMode: 'gui',
      title: 'Standalone merged PR',
      hasCustomTitle: true,
    }),
  });
  const standaloneSessionId = createdStandalone.sessionId ?? createdStandalone.session?.id;
  assert.ok(standaloneSessionId);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-tessera-app-secret': runtime.appSecret },
  });
  await addBrowserAuthCookie(context, runtime);
  await context.addInitScript((project) => {
    localStorage.setItem('ccw:selectedProjectDir', project);
  }, repo);
  page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const archiveRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/archive/tasks/${task.id}`
    ) {
      archiveRequests.push(request.url());
    }
  });

  await page.goto(`${runtime.origin}/chat`, { waitUntil: 'networkidle', timeout: 120_000 });
  const taskRow = page.getByTestId(`collection-task-${task.id}`).first();
  await taskRow.waitFor({ timeout: 30_000 });
  await capture('initial-todo-before-pr-sync', { workflowStatus: 'todo', prState: null });

  await taskRow.click();
  await api(`/api/sessions/${taskSessionId}/refresh-git`, { method: 'POST' });
  const openTask = await waitForTaskState(task.id, 'in_review', 'open');
  const primary = page.getByTestId('desktop-commit-primary');
  await primary.and(page.locator('[data-git-action="view_pr"]')).waitFor({ timeout: 30_000 });
  await primary.getByText('View PR').waitFor();
  const openPrimaryBackground = await primary.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await page.getByTestId('view-mode-board').click();
  const reviewCard = page.locator(
    `[data-testid="kanban-column"][data-status="in_review"] [data-testid="kanban-card"][data-task-id="${task.id}"]`,
  );
  await reviewCard.waitFor({ timeout: 30_000 });
  await capture('open-pr-moves-task-to-review', {
    workflowStatus: openTask.workflowStatus,
    prState: openTask.prStatus.state,
    relation: openTask.prStatus.relation,
  });

  // Orca-style authority: a manual move is visible, then the same unchanged
  // open PR moves the Task back on the next successful sync.
  await api(`/api/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ workflowStatus: 'in_progress' }),
  });
  const doingCard = page.locator(
    `[data-testid="kanban-column"][data-status="in_progress"] [data-testid="kanban-card"][data-task-id="${task.id}"]`,
  );
  await doingCard.waitFor({ timeout: 30_000 });
  await capture('manual-move-to-doing', { workflowStatus: 'in_progress', prState: 'open' });

  await api(`/api/sessions/${taskSessionId}/refresh-git`, { method: 'POST' });
  const reconciledOpenTask = await waitForTaskState(task.id, 'in_review', 'open');
  await reviewCard.waitFor({ timeout: 30_000 });
  await capture('unchanged-open-pr-reconciles-review', {
    workflowStatus: reconciledOpenTask.workflowStatus,
    prState: reconciledOpenTask.prStatus.state,
  });

  // GitHub commonly deletes the source branch as part of merging. Mirror both
  // sides of that state: the server's ls-remote probe must see it gone, and the
  // local panel must lose the tracking ref so ahead/behind become uncountable.
  await git(['update-ref', '-d', 'refs/heads/feature/merged'], remote);
  await git(['update-ref', '-d', 'refs/remotes/origin/feature/merged']);
  await writeGhState('MERGED', headRefOid);
  await api(`/api/sessions/${taskSessionId}/refresh-git`, { method: 'POST' });
  const mergedTask = await waitForTaskState(task.id, 'done', 'merged');
  assert.equal(mergedTask.remoteBranchExists, false);
  const doneCard = page.locator(
    `[data-testid="kanban-column"][data-status="done"] [data-testid="kanban-card"][data-task-id="${task.id}"]`,
  );
  await doneCard.waitFor({ timeout: 30_000 });
  await capture('merged-pr-with-deleted-branch-moves-task-to-done', {
    workflowStatus: mergedTask.workflowStatus,
    prState: mergedTask.prStatus.state,
    relation: mergedTask.prStatus.relation,
    remoteBranchExists: mergedTask.remoteBranchExists,
  });

  await page.getByTestId('view-mode-list').click();
  await page.getByTestId(`collection-task-${task.id}`).first().click();
  await primary.and(page.locator('[data-git-action="archive_worktree"]')).waitFor({
    timeout: 30_000,
  });
  await primary.getByText('Archive Worktree').waitFor();
  const mergedPrimaryColors = await primary.evaluate((element) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--pr-merged-text)';
    document.body.append(probe);
    const colors = {
      actual: getComputedStyle(element).backgroundColor,
      expected: getComputedStyle(probe).backgroundColor,
    };
    probe.remove();
    return colors;
  });
  assert.equal(mergedPrimaryColors.actual, mergedPrimaryColors.expected);
  assert.notEqual(mergedPrimaryColors.actual, openPrimaryBackground);
  await capture('merged-task-shows-archive-worktree', {
    primaryAction: 'archive_worktree',
    backgroundColor: mergedPrimaryColors.actual,
  });

  await primary.click();
  await primary.getByText('Click again to archive').waitFor();
  assert.equal(archiveRequests.length, 0, 'the first click only arms confirmation');
  await capture('first-click-arms-confirmation', {
    archiveRequests: archiveRequests.length,
  });

  await primary.getByText('Archive Worktree').waitFor({ timeout: 5_000 });
  assert.equal(archiveRequests.length, 0, 'confirmation timeout must not archive');
  await capture('confirmation-times-out-safely', {
    archiveRequests: archiveRequests.length,
  });

  await primary.click();
  await primary.getByText('Click again to archive').waitFor();
  await capture('confirmation-rearmed', { archiveRequests: archiveRequests.length });
  const archived = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/archive/tasks/${task.id}`
  ));
  await primary.click();
  assert.equal((await archived).ok(), true);
  assert.equal(archiveRequests.length, 1, 'only the confirmed click archives');
  await taskRow.waitFor({ state: 'detached' });
  const archive = await api('/api/archive?kind=task');
  assert.ok(archive.items.some((item) => item.id === task.id), 'Task is recoverable from Archive');
  await fs.stat(repo);
  await git(['status', '--short']);
  await capture('task-soft-archived-and-worktree-preserved', {
    archiveRequests: archiveRequests.length,
    recoverableFromArchive: true,
    worktreePreserved: true,
  });

  const standaloneRow = page.getByTestId(`collection-chat-${standaloneSessionId}`).first();
  await standaloneRow.click();
  await api(`/api/sessions/${standaloneSessionId}/refresh-git`, { method: 'POST' });
  await primary.and(page.locator('[data-git-action="view_pr"]')).waitFor({ timeout: 30_000 });
  await primary.getByText('View PR').waitFor();
  assert.equal(
    await page.locator('[data-git-action="archive_worktree"]').count(),
    0,
    'standalone merged PR must not expose Task archive',
  );
  await capture('standalone-merged-pr-keeps-view-pr', {
    primaryAction: 'view_pr',
  });

  const expectedNavigationAborts = failedRequests.filter((request) => (
    request.includes('net::ERR_ABORTED')
      && (request.includes('/api/github/star') || request.includes('/api/worktrees/refs?'))
  ));
  const unexpectedFailedRequests = failedRequests.filter(
    (request) => !expectedNavigationAborts.includes(request),
  );
  assert.deepEqual(
    unexpectedFailedRequests,
    [],
    `unexpected browser request failures:\n${unexpectedFailedRequests.join('\n')}`,
  );
  const knownConsoleWarnings = consoleErrors.filter((message) => (
    message.includes('ProviderUsageRail') && message.includes('unique "key" prop')
  ));
  const unexpectedConsoleErrors = consoleErrors.filter((message) => (
    !message.includes('Download the React DevTools') && !knownConsoleWarnings.includes(message)
  ));
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    `unexpected browser console errors:\n${unexpectedConsoleErrors.join('\n')}`,
  );
  evidence.passed = true;
  evidence.assertions = {
    openPrConvergedToInReview: true,
    unchangedOpenPrCorrectedManualMove: true,
    mergedPrConvergedToDone: true,
    mergedRemoteBranchDeleted: true,
    mergedTaskPrimaryAction: 'archive_worktree',
    mergedTaskPrimaryBackground: mergedPrimaryColors.actual,
    openPrPrimaryBackground: openPrimaryBackground,
    firstClickDidNotArchive: true,
    confirmationTimeoutDidNotArchive: true,
    confirmedArchiveRequestCount: archiveRequests.length,
    archiveIsRecoverable: true,
    worktreeWasNotDeleted: true,
    standaloneMergedPrimaryAction: 'view_pr',
    unexpectedBrowserRequestFailures: unexpectedFailedRequests.length,
    expectedNavigationAborts,
    unexpectedBrowserConsoleErrors: unexpectedConsoleErrors.length,
    knownConsoleWarnings,
  };
} catch (error) {
  evidence.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  if (page) {
    await page.screenshot({
      path: path.join(artifactDir, '99-failure.png'),
      fullPage: true,
    }).catch(() => undefined);
  }
  throw error;
} finally {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(evidence, null, 2),
  );
  await browser?.close().catch(() => undefined);
  await runtime?.stop().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: evidence.passed, artifactDir, steps: evidence.steps.length }));
}
