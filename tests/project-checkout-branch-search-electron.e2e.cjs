const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const [repo, cdpUrl, screenshotDir] = process.argv.slice(2);
  const { chromium } = require(path.join(path.resolve(repo), 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdpUrl);
  await fs.mkdir(screenshotDir, { recursive: true });
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    await page.getByTestId('project-strip-all').click();
    const worktree = page.getByTestId('project-worktree-row').first();
    await worktree.click();
    const trigger = page.getByTestId('project-checkout-branch-trigger');
    await trigger.waitFor({ state: 'visible', timeout: 30_000 });
    await trigger.click();
    const menu = page.getByTestId('project-checkout-branch-menu');
    const search = page.getByTestId('project-checkout-branch-search');
    await search.waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="project-checkout-branch"] select').count(), 0);
    const before = await menu.getByRole('option').count();
    assert.ok(before > 5, `expected many branches, got ${before}`);
    await page.screenshot({ path: path.join(screenshotDir, '01-checkout-branch-search-open.png'), fullPage: true });
    await search.fill('terminal');
    const after = await menu.getByRole('option').count();
    assert.ok(after > 0 && after < before, `search did not narrow ${before} -> ${after}`);
    await page.screenshot({ path: path.join(screenshotDir, '02-checkout-branch-search-filtered.png'), fullPage: true });
    console.log(`Checkout branch search narrowed ${before} choices to ${after}.`);
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
