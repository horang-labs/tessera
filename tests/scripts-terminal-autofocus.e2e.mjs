// Windows Node: node tests/scripts-terminal-autofocus.e2e.mjs <isolated-CDP-url> <screenshots-dir>
// Fixture: an open PTY Peek for a disposable Worktree with a running preparation script.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const [cdpUrl, artifactDir] = process.argv.slice(2);
assert.ok(cdpUrl && artifactDir);
await fs.mkdir(artifactDir, { recursive: true });
const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const page = browser.contexts()[0].pages().find(p => /localhost:/.test(p.url()));
  assert.ok(page);
  const peekInput = page.getByTestId('kanban-session-peek').locator('.xterm-helper-textarea');
  await expect(peekInput).toBeFocused({ timeout: 30_000 });
  await page.screenshot({ path: path.join(artifactDir, '01-peek-focused-before-script-mount.png') });
  if (!await page.getByTestId('git-panel').isVisible()) {
    await page.getByTestId('kanban-git-panel-toggle').evaluate(el => el.click());
  }
  // Match passive Scripts auto-selection after Worktree creation: change the
  // selected tab without moving DOM focus as a mouse click would do.
  await page.getByRole('tab', { name: 'Scripts', exact: true }).evaluate(el => el.click());
  const scriptInput = page.getByTestId('worktree-scripts-log').locator('.xterm-helper-textarea');
  await expect(scriptInput).toBeAttached({ timeout: 30_000 });
  // Allow the asynchronous mount/connection and its scheduled activation to settle.
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(artifactDir, '02-after-script-terminal-mounted.png') });
  console.log(await page.evaluate(() => ({
    focusedPanel: document.activeElement?.closest('[data-terminal-panel-id]')?.getAttribute('data-terminal-panel-id'),
  })));
  await expect(peekInput).toBeFocused();
  await expect(scriptInput).not.toBeFocused();
  // The log remains explicitly focusable for users who choose to interact with it.
  await scriptInput.focus();
  await expect(scriptInput).toBeFocused();
  await page.screenshot({ path: path.join(artifactDir, '03-explicit-script-focus.png') });
  await page.getByTestId('kanban-session-peek-close').click();
  await page.getByTestId('view-mode-list').click();
  const workspaceInput = page.locator('[data-panel-wrapper="true"][data-active="true"] .xterm-helper-textarea');
  await expect(workspaceInput).toBeAttached({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Files', exact: true }).evaluate(el => el.click());
  await expect(scriptInput).not.toBeAttached();
  await workspaceInput.focus();
  await page.getByRole('tab', { name: 'Scripts', exact: true }).evaluate(el => el.click());
  await expect(scriptInput).toBeAttached();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(artifactDir, '04-workspace-session-keeps-focus.png') });
  await expect(workspaceInput).toBeFocused();
  await expect(scriptInput).not.toBeFocused();
  console.log('PASS: passive script mount preserves Peek and workspace PTY focus; explicit log focus still works');
} finally { await browser.close(); }
