const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const repo = process.argv[2];
  const cdpUrl = process.argv[3];
  if (!repo || !cdpUrl) {
    throw new Error('Usage: node project-branch-rename-warning-electron.e2e.cjs <repo> <cdp-url>');
  }
  const { chromium } = require(path.join(path.resolve(repo), 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    assert.ok(page, 'Electron renderer page is required');
    await page.getByTestId('branch-rename-warning').waitFor({ timeout: 30_000 });
    const text = await page.getByTestId('branch-rename-warning').innerText();
    assert.match(text, /rename-source/);
    assert.match(text, /renamed/);
    assert.match(text, /hidden/i);
    assert.match(text, /not (moved|changed)/i);

    await page.getByTestId('project-worktree-row').click();
    await page.getByTestId('worktree-peek').waitFor();
    await page.getByTestId('branch-rename-warning-dismiss').click();
    assert.equal(await page.getByTestId('branch-rename-warning').count(), 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('project-worktree-row').waitFor({ timeout: 30_000 });
    assert.equal(
      await page.getByTestId('branch-rename-warning').count(),
      0,
      'Electron UI storage must retain dismissal for the same rename',
    );
    console.log('Packaged Windows server read the WSL reflog; Electron dismissal persisted.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
