/** Issue #317: the integrated Git delivery UI is keyboard-readable at every breakpoint. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  createGitPhoneDeliveryFixture,
  openGitPhoneDeliveryPage,
} from './helpers/git-phone-delivery.mjs';

const { app } = await createGitPhoneDeliveryFixture();
const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.homedir(), 'tmp', 'tessera-ticket-317');
let browser;

async function openAt(viewport, hasTouch = false) {
  const context = await browser.newContext({
    viewport,
    hasTouch,
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  const page = await openGitPhoneDeliveryPage(app, context);
  return { context, page };
}

async function focusedTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
}

async function capture(page, filename) {
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, filename) });
}

try {
  browser = await chromium.launch({ headless: true });
  const desktop = await openAt({ width: 1440, height: 900 });
  try {
    const { page } = desktop;
    const primary = page.getByTestId('desktop-commit-primary');
    await primary.and(page.locator('[data-git-action="commit"]')).waitFor({ timeout: 30_000 });
    assert.match(await primary.getAttribute('aria-label'), /^Commit/);
    await primary.focus();
    await page.keyboard.press('Enter');
    const composer = page.getByTestId('desktop-commit-composer');
    await composer.waitFor();
    assert.ok(await composer.getAttribute('aria-label'));
    assert.equal(await focusedTestId(page), 'git-commit-message');
    assert.ok(await composer.getByTestId('git-commit-message').getAttribute('aria-label'));
    await composer.getByTestId('git-commit-message').fill('keyboard delivery');
    for (const button of await composer.getByRole('button').all()) {
      assert.ok((await button.getAttribute('aria-label')) || (await button.innerText()).trim());
    }
    await page.keyboard.press('Escape');
    await composer.waitFor({ state: 'detached' });

    const menuTrigger = page.getByTestId('desktop-commit-menu-trigger');
    assert.match(await menuTrigger.getAttribute('aria-label'), /git actions/i);
    await menuTrigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('desktop-commit-action-menu');
    await menu.waitFor();
    const enabledItems = menu.getByRole('menuitem').locator(':not(:disabled)');
    assert.ok(await enabledItems.count());
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
    const firstFocused = await focusedTestId(page);
    await page.keyboard.press('End');
    const lastFocused = await focusedTestId(page);
    assert.notEqual(lastFocused, firstFocused);
    await page.keyboard.press('Home');
    assert.equal(await focusedTestId(page), firstFocused);
    for (const item of await menu.getByRole('menuitem').all()) {
      assert.ok((await item.innerText()).trim());
      if (await item.isDisabled()) assert.ok(await item.getAttribute('title'));
    }
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'desktop-commit-menu-trigger');
    assert.equal(await focusedTestId(page), 'desktop-commit-menu-trigger');

    const diffStat = page.getByTestId('desktop-commit-diff-stat');
    assert.match(await diffStat.innerText(), /\+102\s+−1/);
    assert.match(await diffStat.getAttribute('aria-label'), /102 additions, 1 deletion/i);
    await diffStat.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('git-panel').waitFor();
    await capture(page, 'desktop-git-delivery.png');
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 900, height: 700 });
    await primary.waitFor();
    assert.equal(await diffStat.isVisible(), false);
    const mediumControls = await page.locator(
      '[data-testid="desktop-commit-control"], [data-testid="tab-bar-git-toggle"]',
    ).evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    }));
    assert.equal(mediumControls.length, 2);
    assert.ok(mediumControls.every(({ width }) => width > 0));
    assert.ok(mediumControls[0].right <= mediumControls[1].left + 1);
    await capture(page, 'medium-git-delivery.png');
  } finally {
    await desktop.page.unrouteAll({ behavior: 'ignoreErrors' });
    await desktop.context.close();
  }

  const phone = await openAt({ width: 360, height: 776 }, true);
  try {
    const { page } = phone;
    const headerButtons = page.getByTestId('tab-bar').locator('button:visible');
    assert.equal(await headerButtons.count(), 4);
    for (const button of await headerButtons.all()) assert.ok(await button.getAttribute('aria-label'));
    const gitToggle = page.getByTestId('tab-bar-git-toggle');
    await gitToggle.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('git-panel');
    const message = panel.getByTestId('git-commit-message');
    await message.waitFor();
    assert.notEqual(await focusedTestId(page), 'git-commit-message');
    assert.ok(await message.getAttribute('aria-label'));

    const menuTrigger = panel.getByTestId('git-action-menu-trigger');
    await menuTrigger.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByTestId('git-action-menu-sheet');
    await sheet.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
    assert.ok(await sheet.getByRole('menu').getAttribute('aria-label'));
    await capture(page, 'phone-git-delivery.png');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'git-action-menu-trigger');
    assert.equal(await focusedTestId(page), 'git-action-menu-trigger');
    await panel.waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
  } finally {
    await phone.page.unrouteAll({ behavior: 'ignoreErrors' });
    await phone.context.close();
  }
} catch (error) {
  const logs = app.logs();
  if (logs) process.stderr.write(`\n--- isolated server output ---\n${logs.slice(-20_000)}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await app.stop();
}

console.log(JSON.stringify({ artifactDir, breakpoints: [1440, 900, 360], keyboard: true }));
