#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

async function main() {
  const [cdpUrl, screenshotDir] = process.argv.slice(2);
  if (!cdpUrl || !screenshotDir) throw new Error('Usage: <cdp-url> <screenshot-dir>');
  fs.mkdirSync(screenshotDir, { recursive: true });

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    const trigger = page.getByTestId('project-branch-view-filter-trigger').first();
    await trigger.waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({ path: path.join(screenshotDir, '01-project-branch-picker-closed.png') });

    await trigger.click();
    const menu = page.getByTestId('project-branch-view-filter-menu');
    await menu.waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="project-branch-view-filter"] select').count(), 0, 'must not use native select');
    assert.ok(await menu.getByRole('option').count() >= 2, 'must offer All branches and a recorded branch');
    await page.screenshot({ path: path.join(screenshotDir, '02-project-branch-picker-open.png') });

    const branchOption = menu.getByRole('option').nth(1);
    const branchName = (await branchOption.innerText()).trim();
    await branchOption.click();
    await menu.waitFor({ state: 'detached' });
    assert.match(await trigger.innerText(), new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.screenshot({ path: path.join(screenshotDir, '03-project-branch-picker-selected.png') });

    await trigger.click();
    await page.getByTestId('project-branch-view-filter-option-all').click();
    await menu.waitFor({ state: 'detached' });
    assert.match(await trigger.innerText(), /All branches/);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
