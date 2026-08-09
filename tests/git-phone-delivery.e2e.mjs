/** Issue #316: Git delivery stays reachable and truthful at the Phone viewport. */
import assert from 'node:assert/strict';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';
import {
  captureGitPhoneScreenshot,
  createGitPhoneDeliveryFixture,
  holdNextGitAction,
  measureActionSheet,
  measureConfirmationSheet,
  measureVisibleHeaderControls,
  openDesktopGitActionMenu,
  openGitPhoneDeliveryPage,
} from './helpers/git-phone-delivery.mjs';

const { app, artifactDir } = await createGitPhoneDeliveryFixture();
let browser;

try {
  browser = await launchPhoneBrowser();
  const context = await createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  let page;
  try {
    page = await openGitPhoneDeliveryPage(app, context);
    const gitControl = page.getByTestId('tab-bar-git-toggle');
    await page.getByTestId('git-phone-changed-badge').getByText('99+', { exact: true })
      .waitFor({ timeout: 30_000 });
    assert.match(await gitControl.getAttribute('aria-label'), /git panel.*101 changed files/i);
    assert.equal(await gitControl.getAttribute('aria-busy'), 'false');
    await page.getByTestId('git-phone-stable-icon').waitFor();

    const controls = await measureVisibleHeaderControls(page);
    assert.equal(controls.length, 4, `phone header controls changed: ${JSON.stringify(controls)}`);
    for (const control of controls) {
      assert.ok(control.width >= 44 && control.height >= 44,
        `undersized header control: ${JSON.stringify(control)}`);
    }

    await gitControl.click();
    const panel = page.getByTestId('git-panel');
    const fixedAction = page.getByTestId('git-panel-fixed-action');
    const phoneScroll = page.getByTestId('git-panel-phone-scroll');
    const message = panel.getByTestId('git-commit-message');
    await panel.waitFor();
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
    assert.ok(await phoneScroll.evaluate((element) => element.scrollTop) > 0,
      'the changed-file content did not scroll');
    assert.ok(actionAfter && Math.abs(actionAfter.y - actionBefore.y) <= 1,
      `the action moved while files scrolled: ${actionBefore.y} -> ${actionAfter?.y}`);
    await captureGitPhoneScreenshot(page, artifactDir, 'phone-fixed-composer.png');

    await panel.getByTestId('git-commit-file-checkbox-README.md').check();
    await message.fill('phone delivery');
    await page.getByTestId('git-action-menu-trigger').click();
    const actionSheet = page.getByTestId('git-action-menu-sheet');
    await actionSheet.waitFor();
    const actionSheetMetrics = await measureActionSheet(actionSheet);
    assert.ok(Math.abs(actionSheetMetrics.bottom - actionSheetMetrics.viewport) <= 1
      && actionSheetMetrics.paddingBottom >= 16,
    `action sheet ignored the safe bottom: ${JSON.stringify(actionSheetMetrics)}`);
    assert.ok(actionSheetMetrics.rows.every((height) => height >= 44),
      `short action rows: ${actionSheetMetrics.rows}`);
    assert.ok(actionSheetMetrics.disabledReasons.length > 0, 'disabled actions hid every reason');
    await captureGitPhoneScreenshot(page, artifactDir, 'phone-action-sheet.png');
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
    const confirmationMetrics = await measureConfirmationSheet(confirmation);
    assert.ok(Math.abs(confirmationMetrics.bottom - confirmationMetrics.viewport) <= 1
      && confirmationMetrics.paddingBottom >= 16,
    `confirmation sheet ignored the safe bottom: ${JSON.stringify(confirmationMetrics)}`);
    assert.ok(confirmationMetrics.buttons.every(({ height, name }) => height >= 44 && name),
      `confirmation controls were inaccessible: ${JSON.stringify(confirmationMetrics.buttons)}`);
    await captureGitPhoneScreenshot(page, artifactDir, 'phone-default-confirmation.png');
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

    const releaseAction = await holdNextGitAction(page);
    await panel.getByTestId('git-primary-action-button').click();
    await page.getByTestId('git-default-branch-confirm-sheet').waitFor();
    await page.getByTestId('git-default-branch-confirm-accept').click();
    await page.getByTestId('git-default-branch-confirm-sheet').waitFor({ state: 'detached' });
    await panel.getByTestId('git-panel-close-btn').click();
    await page.getByTestId('git-phone-pending-indicator').waitFor();
    assert.equal(await gitControl.getAttribute('aria-busy'), 'true');
    await page.getByTestId('git-phone-stable-icon').waitFor();
    await captureGitPhoneScreenshot(page, artifactDir, 'phone-pending-badge.png');
    releaseAction();
    await page.waitForFunction(() => document.querySelector('[data-testid="tab-bar-git-toggle"]')
      ?.getAttribute('aria-busy') === 'false');
  } finally {
    await page?.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }

  const desktop = await openDesktopGitActionMenu(app, browser);
  try {
    assert.equal(await desktop.page.getByTestId('git-action-menu-sheet').count(), 0);
  } finally {
    await desktop.context.close();
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
