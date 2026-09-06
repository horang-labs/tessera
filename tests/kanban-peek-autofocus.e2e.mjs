// Windows Node: node tests/kanban-peek-autofocus.e2e.mjs <isolated-CDP-url> <session-id> <screenshots-dir>
// Use a disposable PTY session in an isolated packaged app, with Board/Peek enabled.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const [cdpUrl, sessionId, artifactDir] = process.argv.slice(2);
assert.ok(cdpUrl && sessionId && artifactDir, 'CDP URL, session ID, and screenshot directory are required');
await fs.mkdir(artifactDir, { recursive: true });
const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const page = browser.contexts()[0].pages().find((candidate) => /localhost:/.test(candidate.url()));
  assert.ok(page, 'Expected the packaged server renderer');
  await page.bringToFront();
  await page.getByTestId('view-mode-board').click();
  const peek = page.getByTestId('kanban-session-peek');
  const toggle = peek.getByTestId('kanban-session-peek-terminal-view-toggle');
  const close = peek.getByTestId('kanban-session-peek-close');
  const card = page.locator(`[data-testid="kanban-card"][data-session-id="${sessionId}"]`);
  const shot = (name) => page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
  // Normalize the fixture without relying on a previous run's persisted view.
  if (await peek.isVisible()) {
    if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
    await close.click();
  }
  await shot('30-board-before-peek');
  await card.click();
  await expect(peek.locator('.xterm-helper-textarea')).toBeFocused({ timeout: 30_000 });
  await shot('31-terminal-peek-focused');
  await toggle.click();
  const composer = peek.getByTestId('terminal-chat-composer-input');
  await expect(composer).toBeVisible();
  await shot('32-chat-view-after-toggle');
  await expect(composer).toBeFocused();
  await page.keyboard.insertText('peek focus regression');
  await expect(composer).toHaveValue('peek focus regression');
  await shot('33-chat-typed-without-click');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await close.click();
  await shot('34-closed-peek');
  await card.click();
  await expect(composer).toBeFocused({ timeout: 30_000 });
  await shot('35-reopened-chat-focused');
  await toggle.click();
  await expect(peek.locator('.xterm-helper-textarea')).toBeFocused();
  await shot('36-returned-terminal-focused');
  await close.click();
  console.log('PASS: terminal open, chat toggle, typing without click, chat reopen, terminal return');
} finally {
  await browser.close();
}
