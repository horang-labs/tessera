/** Issue #316: Git delivery stays reachable and truthful at the Phone viewport. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { startPhoneAppServer } from './helpers/phone-app-server.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';

const run = promisify(execFile);
const app = await startPhoneAppServer({ name: 'git-phone-delivery' });
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.homedir(), 'tmp', 'tessera-ticket-316');
let browser;

async function git(args, cwd = app.projectDir) {
  return run('git', ['-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args], { cwd });
}

try {
  const remote = path.join(path.dirname(app.projectDir), 'remote.git');
  await git(['init', '--bare', '--initial-branch=main', remote], path.dirname(app.projectDir));
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'seed']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  await git(['remote', 'set-head', 'origin', 'main']);
  await fs.writeFile(path.join(app.projectDir, 'README.md'), '# changed\nplus one\n', 'utf8');
  await Promise.all(Array.from({ length: 100 }, (_, index) => (
    fs.writeFile(path.join(app.projectDir, `phone-${String(index).padStart(3, '0')}.txt`), `line ${index}\n`, 'utf8')
  )));

  browser = await launchPhoneBrowser();
  const context = await createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  let page;
  try {
    await context.addInitScript((projectDir) => {
      localStorage.setItem('ccw:selectedProjectDir', projectDir);
      localStorage.removeItem('tessera:git-panel');
    }, app.projectDir);
    page = await app.preparePage(context);
    await page.route(`**/api/sessions/${app.sessionId}/git`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({
        response,
        json: {
          ...payload,
          diffStats: {
            added: 102,
            removed: 1,
            changedFiles: 101,
            newFiles: 100,
            deletedFiles: 0,
            computedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      });
    });
    await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
    await page.getByTestId('tab-bar').waitFor({ state: 'visible', timeout: 30_000 });

    const gitControl = page.getByTestId('tab-bar-git-toggle');
    await page.getByTestId('git-phone-changed-badge').getByText('99+', { exact: true })
      .waitFor({ timeout: 30_000 });
    assert.match(await gitControl.getAttribute('aria-label'), /git panel.*101 changed files/i);
    assert.equal(await gitControl.getAttribute('aria-busy'), 'false');
    await page.getByTestId('git-phone-stable-icon').waitFor();

    const controls = await page.getByTestId('tab-bar').locator('button').evaluateAll((buttons) => (
      buttons.filter((button) => button.getBoundingClientRect().width > 0).map((button) => {
        const box = button.getBoundingClientRect();
        return { name: button.getAttribute('aria-label'), width: box.width, height: box.height };
      })
    ));
    assert.equal(controls.length, 4, `phone header controls changed: ${JSON.stringify(controls)}`);
    for (const control of controls) {
      assert.ok(control.width >= 44 && control.height >= 44, `undersized header control: ${JSON.stringify(control)}`);
    }

    await gitControl.click();
    const panel = page.getByTestId('git-panel');
    await panel.waitFor();
    const fixedAction = page.getByTestId('git-panel-fixed-action');
    const phoneScroll = page.getByTestId('git-panel-phone-scroll');
    const message = panel.getByTestId('git-commit-message');
    await fixedAction.waitFor();
    await message.waitFor();
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
      'git-commit-message', 'opening a dirty panel summoned the commit textarea');

    await panel.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    await gitControl.click();
    await message.waitFor();
    assert.equal(await panel.getByRole('tab', { name: 'Git', exact: true }).getAttribute('aria-selected'), 'true',
      'the stable Git entry point reopened a different persisted panel tab');

    const tabBottom = await panel.getByRole('tablist', { name: /right panel/i })
      .evaluate((element) => element.getBoundingClientRect().bottom);
    const actionBefore = await fixedAction.boundingBox();
    assert.ok(actionBefore && actionBefore.y <= tabBottom + 16,
      `the fixed action starts ${actionBefore?.y - tabBottom}px below the panel tabs`);
    await panel.getByText('+102 -1 / 101', { exact: true }).waitFor();
    await panel.getByTestId('git-commit-selection-summary').getByText('101 selected').waitFor();
    await panel.getByTestId('git-commit-file-checkbox-README.md').uncheck();
    await panel.getByTestId('git-commit-selection-summary').getByText('100 selected').waitFor();
    await panel.getByText('+102 -1 / 101', { exact: true }).waitFor();

    await panel.locator('[data-testid^="git-panel-file-row-"]').last().scrollIntoViewIfNeeded();
    const actionAfter = await fixedAction.boundingBox();
    const scrollTop = await phoneScroll.evaluate((element) => element.scrollTop);
    assert.ok(scrollTop > 0, 'the changed-file content did not scroll');
    assert.ok(actionAfter && Math.abs(actionAfter.y - actionBefore.y) <= 1,
      `the action moved while files scrolled: ${actionBefore.y} -> ${actionAfter?.y}`);
    await fs.mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, 'phone-fixed-composer.png') });

    await panel.getByTestId('git-commit-file-checkbox-README.md').check();
    await message.fill('phone delivery');
    await page.getByTestId('git-action-menu-trigger').click();
    const actionSheet = page.getByTestId('git-action-menu-sheet');
    await actionSheet.waitFor();
    const sheetMetrics = await actionSheet.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      viewport: window.innerHeight,
      paddingBottom: parseFloat(getComputedStyle(element).paddingBottom),
      rows: Array.from(element.querySelectorAll('[role="menuitem"]')).map((row) => row.getBoundingClientRect().height),
      disabledReasons: Array.from(element.querySelectorAll('button:disabled span:last-child'))
        .map((span) => span.textContent?.trim()).filter(Boolean),
    }));
    assert.ok(Math.abs(sheetMetrics.bottom - sheetMetrics.viewport) <= 1 && sheetMetrics.paddingBottom >= 16,
      `action sheet ignored the safe bottom: ${JSON.stringify(sheetMetrics)}`);
    assert.ok(sheetMetrics.rows.every((height) => height >= 44), `short action rows: ${sheetMetrics.rows}`);
    assert.ok(sheetMetrics.disabledReasons.length > 0, 'disabled actions hid every reason');
    await page.screenshot({ path: path.join(artifactDir, 'phone-action-sheet.png') });
    await page.keyboard.press('Escape');
    await actionSheet.waitFor({ state: 'detached' });
    await panel.waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    await gitControl.click();
    await panel.waitFor();

    await page.getByTestId('git-action-menu-trigger').click();
    await page.getByTestId('git-action-menu-item-commit_push').click();
    const confirmation = page.getByTestId('git-default-branch-confirm-sheet');
    await confirmation.waitFor();
    await page.getByTestId('git-action-menu-sheet').waitFor({ state: 'detached' });
    assert.equal(await confirmation.getAttribute('role'), 'dialog');
    const confirmationMetrics = await confirmation.evaluate((element) => ({
      bottom: element.getBoundingClientRect().bottom,
      viewport: window.innerHeight,
      paddingBottom: parseFloat(getComputedStyle(element).paddingBottom),
      buttons: Array.from(element.querySelectorAll('button')).map((button) => ({
        height: button.getBoundingClientRect().height,
        name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
      })),
    }));
    assert.ok(Math.abs(confirmationMetrics.bottom - confirmationMetrics.viewport) <= 1
      && confirmationMetrics.paddingBottom >= 16,
    `confirmation sheet ignored the safe bottom: ${JSON.stringify(confirmationMetrics)}`);
    assert.ok(confirmationMetrics.buttons.every(({ height, name }) => height >= 44 && name),
      `confirmation controls were inaccessible: ${JSON.stringify(confirmationMetrics.buttons)}`);
    await page.screenshot({ path: path.join(artifactDir, 'phone-default-confirmation.png') });
    await page.evaluate(() => history.back());
    await confirmation.waitFor({ state: 'detached' });
    await panel.waitFor();
    await page.evaluate(() => history.back());
    await panel.waitFor({ state: 'detached' });
    await gitControl.click();
    await panel.waitFor();

    await panel.getByTestId('git-primary-action-button').click();
    await panel.locator('[data-testid="git-primary-action-button"][data-git-action="push"]')
      .waitFor({ timeout: 30_000 });
    assert.ok(Math.abs((await fixedAction.boundingBox()).y - actionBefore.y) <= 1,
      'successful Commit moved the rederived Primary Git Action');

    let releaseAction;
    const actionHeld = new Promise((resolve) => { releaseAction = resolve; });
    await page.route('**/git/action', async (route) => {
      await actionHeld;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"held failure"}' });
    });
    await panel.getByTestId('git-primary-action-button').click();
    await page.getByTestId('git-default-branch-confirm-sheet').waitFor();
    await page.getByTestId('git-default-branch-confirm-accept').click();
    await page.getByTestId('git-default-branch-confirm-sheet').waitFor({ state: 'detached' });
    await panel.getByTestId('git-panel-close-btn').click();
    await page.getByTestId('git-phone-pending-indicator').waitFor();
    assert.equal(await gitControl.getAttribute('aria-busy'), 'true');
    await page.getByTestId('git-phone-stable-icon').waitFor();
    await page.screenshot({ path: path.join(artifactDir, 'phone-pending-badge.png') });
    releaseAction();
    await page.waitForFunction(() => document.querySelector('[data-testid="tab-bar-git-toggle"]')?.getAttribute('aria-busy') === 'false');
  } finally {
    await page?.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }

  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 900 }, hasTouch: false,
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  try {
    await desktop.addInitScript((projectDir) => localStorage.setItem('ccw:selectedProjectDir', projectDir), app.projectDir);
    const page = await app.preparePage(desktop);
    await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
    await page.getByTestId('desktop-commit-control').waitFor({ timeout: 30_000 });
    await page.getByTestId('desktop-commit-menu-trigger').click();
    await page.getByTestId('desktop-commit-action-menu').waitFor();
    assert.equal(await page.getByTestId('git-action-menu-sheet').count(), 0);
  } finally {
    await desktop.close();
  }
} catch (error) {
  const logs = app.logs();
  if (logs) process.stderr.write(`\n--- isolated server output ---\n${logs.slice(-20_000)}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await app.stop();
}

console.log(JSON.stringify({ artifactDir, changedFiles: 101 }));
