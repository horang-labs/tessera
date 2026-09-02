const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const [repo, cdpUrl, projectPath, screenshotDir] = process.argv.slice(2);
  if (!repo || !cdpUrl || !projectPath || !screenshotDir) {
    throw new Error(
      'Usage: node project-checkout-branch-electron.e2e.cjs <repo> <cdp-url> <project-path> <screenshot-dir>',
    );
  }
  const { chromium } = require(path.join(path.resolve(repo), 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdpUrl);
  await fs.mkdir(screenshotDir, { recursive: true });
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    assert.ok(page, 'Electron renderer page is required');
    let projectId = projectPath;
    await page.getByTestId('project-strip-all').click();
    let section = page.getByTestId(`all-project-section-${projectId}`);
    if (await section.count() === 0) {
      const registration = await page.evaluate(async (folderPath) => {
        const response = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folderPath }),
        });
        return { ok: response.ok, payload: await response.json().catch(() => ({})) };
      }, projectPath);
      assert.equal(registration.ok, true, JSON.stringify(registration.payload));
      projectId = registration.payload.projectId;
      assert.equal(typeof projectId, 'string');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('project-strip-all').click();
      section = page.getByTestId(`all-project-section-${projectId}`);
    }
    await section.waitFor({ timeout: 30_000 });
    let projectWorktree = section.getByTestId('project-worktree-row');
    if (await projectWorktree.count() === 0) {
      await section.locator(':scope > div').first().click();
      projectWorktree = section.getByTestId('project-worktree-row');
    }
    await projectWorktree.waitFor();
    await projectWorktree.click();

    const peek = page.getByTestId('worktree-peek');
    const branchControl = page.getByTestId('project-checkout-branch');
    const branchTrigger = page.getByTestId('project-checkout-branch-trigger');
    const branchSubmit = page.getByTestId('project-checkout-branch-submit');
    await peek.waitFor();
    await branchControl.waitFor();
    await branchTrigger.click();
    const branchMenu = page.getByTestId('project-checkout-branch-menu');
    await branchMenu.getByTestId('project-checkout-branch-option-branch-a').waitFor({ state: 'visible' });
    await branchMenu.getByTestId('project-checkout-branch-option-branch-b').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('project-checkout-branch-search').count(), 1);
    await branchMenu.getByTestId('project-checkout-branch-option-branch-a').click();
    assert.match(await branchTrigger.innerText(), /branch-a \(current\)/);
    await page.screenshot({
      path: path.join(screenshotDir, '01-project-checkout-branch-a.png'),
      fullPage: true,
    });

    async function switchTo(branch, screenshotName) {
      await branchTrigger.click();
      await page.getByTestId('project-checkout-branch-search').fill(branch);
      await page.getByTestId(`project-checkout-branch-option-${branch}`).click();
      assert.equal(await branchSubmit.isEnabled(), true);
      await branchSubmit.click();
      await assert.doesNotReject(async () => {
        await page.waitForFunction(
          ({ triggerTestId, expected }) => {
            const trigger = document.querySelector(`[data-testid="${triggerTestId}"]`);
            return trigger?.textContent?.includes(`${expected} (current)`);
          },
          { triggerTestId: 'project-checkout-branch-trigger', expected: branch },
          { timeout: 30_000 },
        );
      });
      assert.match(await page.getByTestId('worktree-overview').innerText(), new RegExp(branch));
      await page.screenshot({ path: path.join(screenshotDir, screenshotName), fullPage: true });
    }

    await switchTo('branch-b', '02-switched-to-branch-b.png');
    await switchTo('branch-a', '03-switched-back-to-branch-a.png');
    await switchTo('branch-b', '04-final-branch-b.png');
    console.log('Packaged Electron switched branch-a -> branch-b -> branch-a -> branch-b.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
