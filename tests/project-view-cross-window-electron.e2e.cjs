const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function requireIsolatedRuntime(cdpUrl, serverUrl, dataDir) {
  const cdp = new URL(cdpUrl);
  const server = new URL(serverUrl);
  for (const url of [cdp, server]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.notEqual(server.port, '32123', 'refusing to target the normal Tessera server');
  const instanceRoot = path.dirname(dataDir);
  const manifestPath = path.join(path.dirname(instanceRoot), 'sessions', `${path.basename(instanceRoot)}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  const instance = manifest.instances.find((item) => path.resolve(item.dataDir) === path.resolve(dataDir));
  assert.equal(instance?.serverPort, Number(server.port), 'server/data directory do not share an isolated manifest');
  return server;
}
async function waitForPendingPairing(source) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await source.evaluate(() => window.electronAPI.listPairingRequests());
    const pending = result.requests?.find((request) => request.status === 'pending');
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('receiver pairing request did not reach Electron');
}
async function main() {
  const [repo, cdpUrl, serverUrl, screenshotDir, fixtureProjectDir] = process.argv.slice(2);
  assert.ok(repo && cdpUrl && serverUrl && screenshotDir && fixtureProjectDir,
    'usage: <repo> <cdp-url> <server-url> <screenshot-dir> <fixture-project-dir>');
  const isolatedServer = requireIsolatedRuntime(cdpUrl, serverUrl, screenshotDir);
  const { chromium, expect } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdpUrl);
  let receiverContext;
  try {
    const context = browser.contexts()[0];
    const source = context.pages().find((page) => page.url().includes('/chat'));
    assert.ok(source, 'missing packaged /chat renderer');
    assert.equal(new URL(source.url()).origin, isolatedServer.origin);
    assert.equal(await source.evaluate(() => window.electronAPI?.isElectron), true);
    await source.evaluate(() => window.electronAPI.closeBoardPopouts());
    await expect.poll(() => context.pages().length).toBe(1);
    const fixture = await source.evaluate(async (projectDir) => {
      const request = async (url, body) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`${url} failed (${response.status}): ${result.error}`);
        return result;
      };
      const project = await request('/api/projects', { folderPath: projectDir });
      const createdTask = await request('/api/tasks', {
        projectId: project.projectId,
        title: 'Issue 332 cross-window runtime fixture',
        workflowStatus: 'todo',
      });
      const anchor = await request('/api/sessions', {
        workDir: project.projectId,
        title: 'Issue 332 source A anchor',
        providerId: 'codex',
        executionMode: 'pty',
      });
      const checkout = await request('/api/worktrees', {
        projectDir: project.projectId,
        taskId: createdTask.task.id,
        branchPrefix: 'test',
        branchSlug: 'issue-332-runtime',
      });
      const alternate = await request('/api/projects', { folderPath: checkout.worktreePath });
      const session = await request('/api/sessions', {
        workDir: checkout.worktreePath,
        parentProjectId: project.projectId,
        taskId: createdTask.task.id,
        worktreeBranch: checkout.branchName,
        title: 'Issue 332 linked Session',
        hasCustomTitle: true,
        providerId: 'codex',
        executionMode: 'pty',
      });
      return { ownerProjectId: project.projectId, alternateProjectId: alternate.projectId,
        anchorSessionId: anchor.sessionId, taskId: createdTask.task.id, sessionId: session.sessionId,
        worktreePath: checkout.worktreePath, branchName: checkout.branchName };
    }, fixtureProjectDir);
    await source.reload();
    await source.getByTestId(`project-strip-${fixture.ownerProjectId}`).click();
    await source.getByTestId('view-mode-board').click();
    await source.getByTestId('collection-filter-all').click();
    await expect(source.locator(`[data-task-id="${fixture.taskId}"]`)).toBeVisible();
    await source.locator(`[data-session-id="${fixture.anchorSessionId}"]`).first().click();
    await source.getByTestId(`project-strip-${fixture.ownerProjectId}`).click();
    receiverContext = await chromium.launchPersistentContext(
      path.join(screenshotDir, 'issue-332-receiver-profile'),
      { channel: 'msedge', headless: true },
    );
    const receiver = receiverContext.pages()[0] ?? await receiverContext.newPage();
    const settingsStatus = await source.evaluate((advertisedAddress) => fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineSettings: { advertisedAddress } }),
    }).then((response) => response.status), serverUrl);
    assert.equal(settingsStatus, 200, 'failed to set isolated advertised address');
    const pairing = await source.evaluate(() => window.electronAPI.createPairingCode('rotate'));
    assert.equal(pairing.ok, true, pairing.error ?? 'pairing link creation failed');
    const token = new URLSearchParams(new URL(pairing.pairingLink).hash.slice(1)).get('t');
    assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/);
    await receiver.goto(`${serverUrl.replace(/\/$/, '')}/pair#t=${token}`);
    await receiver.getByTestId('pairing-waiting').waitFor();
    const request = await waitForPendingPairing(source);
    const decision = await source.evaluate((requestId) => (
      window.electronAPI.decidePairingRequest(requestId, 'approve')
    ), request.id);
    assert.equal(decision.ok, true, decision.error ?? 'pairing approval failed');
    await receiver.waitForURL(/\/chat(?:$|\?)/, { timeout: 30_000 });
    await expect(receiver).toHaveTitle('Tessera');
    assert.equal(new URL(receiver.url()).pathname, '/chat',
      `receiver did not authenticate: ${(await receiver.locator('body').innerText()).slice(0, 200)}`);
    await receiver.getByTestId(`project-strip-${fixture.alternateProjectId}`).click();
    await receiver.getByTestId('view-mode-board').click();
    await receiver.getByTestId('collection-filter-all').click();
    await expect(receiver.locator(`[data-session-id="${fixture.sessionId}"]`)).toBeVisible();
    const mutate = (patch) => source.evaluate(async ({ taskId, patch }) => {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Tessera-Client-Id': 'issue-332-runtime-probe',
        },
        body: JSON.stringify(patch),
      });
      return { ok: response.ok, status: response.status };
    }, { taskId: fixture.taskId, patch });
    const expectEveryTitle = (page, title) => expect.poll(async () => {
      const texts = await page.locator(`[data-session-id="${fixture.sessionId}"]`).allTextContents();
      return texts.length > 0 && texts.every((text) => text.includes(title));
    }, { timeout: 20_000 }).toBe(true);
    const expectSourceProjectStable = async () => {
      await expect(source.getByTestId(`project-strip-${fixture.ownerProjectId}`))
        .toHaveClass(/opacity-100/);
      await expect(source.locator(`[data-task-id="${fixture.taskId}"]`)).toBeVisible();
    };
    await expectSourceProjectStable();
    assert.deepEqual(await mutate({ workflowStatus: 'in_progress' }), { ok: true, status: 200 });
    await expect(source.locator(
      `[data-status="in_progress"] [data-task-id="${fixture.taskId}"]`,
    )).toBeVisible({ timeout: 20_000 });
    await expect(receiver.locator(
      `[data-status="in_progress"] [data-session-id="${fixture.sessionId}"]`,
    )).toBeVisible({ timeout: 20_000 });
    await expectSourceProjectStable();
    await expect(receiver.getByTestId(`project-strip-${fixture.alternateProjectId}`)).toHaveClass(/opacity-100/);
    const originalTitle = 'Issue 332 cross-window runtime fixture';
    const nextTitle = `Issue 332 converged ${fixture.taskId.slice(-6)}`;
    assert.deepEqual(await mutate({ title: nextTitle }), { ok: true, status: 200 });
    await expect(source.locator(`[data-task-id="${fixture.taskId}"]`))
      .toContainText(nextTitle, { timeout: 20_000 });
    await expectSourceProjectStable();
    await expectEveryTitle(receiver, nextTitle);
    const screenshots = {
      source: path.join(screenshotDir, 'issue-332-source.png'),
      receiver: path.join(screenshotDir, 'issue-332-receiver.png'),
    };
    await source.screenshot({ path: screenshots.source });
    await receiver.screenshot({ path: screenshots.receiver });
    assert.deepEqual(await mutate({ title: originalTitle }), { ok: true, status: 200 });
    await expect(source.locator(`[data-task-id="${fixture.taskId}"]`))
      .toContainText(originalTitle, { timeout: 20_000 });
    await expectSourceProjectStable();
    await expectEveryTitle(receiver, originalTitle);
    assert.deepEqual(await mutate({ workflowStatus: 'todo' }), { ok: true, status: 200 });
    await expect(source.locator(
      `[data-status="todo"] [data-task-id="${fixture.taskId}"]`,
    )).toBeVisible({ timeout: 20_000 });
    await expectSourceProjectStable();
    await expect(receiver.locator(
      `[data-status="todo"] [data-session-id="${fixture.sessionId}"]`,
    )).toBeVisible({ timeout: 20_000 });
    process.stdout.write(`${JSON.stringify({
      ...fixture,
      workflowTransition: 'todo -> in_progress -> todo',
      titleTransition: `${originalTitle} -> ${nextTitle} -> ${originalTitle}`,
      sourceProjectStableAcrossMutations: true,
      screenshots,
    }, null, 2)}\n`);
  } finally {
    await receiverContext?.close();
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
