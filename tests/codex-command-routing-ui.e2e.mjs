import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL ?? 'http://127.0.0.1:3210/chat';
const sessionId = process.env.TESSERA_E2E_SESSION_ID;
const outputDir = process.env.TESSERA_E2E_SCREENSHOT_DIR
  ?? path.resolve('_bmad-output/implementation-artifacts/codex-command-routing-e2e');

if (!sessionId) {
  throw new Error('TESSERA_E2E_SESSION_ID is required');
}

await fs.mkdir(outputDir, { recursive: true });
for (const filename of await fs.readdir(outputDir)) {
  if (/^\d{2}[a-z]?-.*\.png$/.test(filename)) {
    await fs.rm(path.join(outputDir, filename), { force: true });
  }
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const results = {};
const terminalInputFrames = [];
const forkPrefillPattern = /['"]?codex['"]?\s+['"]?fork['"]?\s+['"]?[0-9a-f-]{36}['"]?/i;

page.on('websocket', (socket) => {
  socket.on('framesent', ({ payload }) => {
    if (typeof payload !== 'string') return;
    try {
      const message = JSON.parse(payload);
      if (message?.type !== 'terminal_input' || typeof message.data !== 'string') return;
      terminalInputFrames.push({
        terminalId: message.terminalId,
        data: message.data,
        codePoints: [...message.data].map((character) => character.codePointAt(0)),
      });
    } catch {
      // Non-JSON WebSocket frames are outside this UI contract test.
    }
  });
});

async function screenshot(name) {
  const target = path.join(outputDir, name);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

async function composer() {
  const input = page.locator(`textarea[data-session-input=${JSON.stringify(sessionId)}]`);
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  return input;
}

async function command(value) {
  const input = await composer();
  await input.fill(value);
  await input.press('Enter');
  return input;
}

async function messageCount() {
  const response = await page.request.get(
    `${new URL(appUrl).origin}/api/sessions/${sessionId}/messages?limit=25`,
  );
  assert.equal(response.ok(), true, `messages API returned ${response.status()}`);
  const payload = await response.json();
  assert.equal(Array.isArray(payload.messages), true);
  return payload.messages.length;
}

async function terminalText() {
  return (await page.locator('[data-testid="terminal-panel"] .xterm-rows').textContent()) ?? '';
}

try {
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
  await composer();
  const initialMessageCount = await messageCount();

  const input = await composer();
  await input.fill('/');
  const picker = page.getByRole('listbox');
  await picker.waitFor({ timeout: 10_000 });
  const initialThemeOption = page.getByRole('option', { name: /\/theme/ });
  await initialThemeOption.waitFor({ timeout: 10_000 });
  const initialThemeLabel = (await initialThemeOption.textContent()) ?? '';
  results.picker = {
    themeVisible: await initialThemeOption.count() === 1,
    themeTerminalBadge: /terminal/i.test(initialThemeLabel),
    deleteHidden: await page.getByRole('option', { name: /\/delete/ }).count() === 0,
    windowsCommandHidden: await page.getByRole('option', { name: /\/setup-default-sandbox/ }).count() === 0,
  };
  assert.deepEqual(results.picker, {
    themeVisible: true,
    themeTerminalBadge: true,
    deleteHidden: true,
    windowsCommandHidden: true,
  });
  await screenshot('01-command-picker-routes.png');
  await input.fill('/theme');
  const themeOption = page.getByRole('option', { name: /\/theme/ });
  await themeOption.waitFor({ timeout: 10_000 });
  await themeOption.scrollIntoViewIfNeeded();
  await screenshot('01b-terminal-route-theme.png');
  await input.press('Escape');

  await command('/model');
  await page.getByTestId('model-selector-menu').waitFor({ timeout: 10_000 });
  results.modelMenuOpened = true;
  assert.equal(results.modelMenuOpened, true);
  await screenshot('02-native-model-menu.png');
  await page.keyboard.press('Escape');

  await command('/permissions');
  await page.getByTestId('access-mode-selector-menu').waitFor({ timeout: 10_000 });
  results.permissionsMenuOpened = true;
  assert.equal(results.permissionsMenuOpened, true);
  await screenshot('03-native-permissions-menu.png');
  await page.keyboard.press('Escape');

  await command('/plan');
  await page.getByTestId('plan-mode-toggle').waitFor({ timeout: 10_000 });
  results.planModeActivated = await page.getByTestId('plan-mode-toggle').getAttribute('aria-pressed') === 'true';
  assert.equal(results.planModeActivated, true);
  await screenshot('04-native-plan-mode.png');
  await page.getByTestId('plan-mode-toggle').click();

  await command('/rename');
  const renameInput = page.locator('input[type=text][value="Command Routing UI E2E"]').first();
  await renameInput.waitFor({ timeout: 10_000 });
  results.renameFocused = await renameInput.evaluate((element) => document.activeElement === element);
  assert.equal(results.renameFocused, true);
  await screenshot('05-native-rename-editor.png');
  await renameInput.press('Escape');

  await command('/skills');
  await picker.waitFor({ timeout: 10_000 });
  const skillOptionLabels = await picker.getByRole('option').allTextContents();
  const skillsEmptyStateVisible = await page
    .getByText(/스킬을 사용할 수 있습니다|send a message.*skills/i)
    .isVisible()
    .catch(() => false);
  results.skillsOnly = {
    count: skillOptionLabels.length,
    providerStateRendered: skillOptionLabels.length > 0 || skillsEmptyStateVisible,
    themeExcluded: skillOptionLabels.every((label) => !label.includes('/theme')),
    deleteExcluded: skillOptionLabels.every((label) => !label.includes('/delete')),
  };
  assert.equal(results.skillsOnly.providerStateRendered, true);
  assert.equal(results.skillsOnly.themeExcluded, true);
  assert.equal(results.skillsOnly.deleteExcluded, true);
  await screenshot('06-native-skills-only-picker.png');
  await (await composer()).press('Escape');

  await command('/delete');
  const hiddenToast = page.getByText(/Tessera.*지원하지 않습니다/).last();
  await hiddenToast.waitFor({ timeout: 10_000 });
  await hiddenToast.screenshot({
    path: path.join(outputDir, '07a-hidden-delete-message.png'),
  });
  results.hiddenDelete = {
    terminalCount: await page.getByTestId('terminal-panel').count(),
    draftPreserved: await (await composer()).inputValue() === '/delete',
  };
  assert.deepEqual(results.hiddenDelete, {
    terminalCount: 0,
    draftPreserved: true,
  });
  await screenshot('07-hidden-delete-blocked.png');
  await (await composer()).fill('');

  const directInputFrameStart = terminalInputFrames.length;
  const directInput = await composer();
  await directInput.fill('/th');
  await picker.waitFor({ timeout: 10_000 });
  await page.getByRole('option', { name: /\/theme/ }).click();
  const terminal = page.getByTestId('terminal-panel');
  await terminal.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const rows = document.querySelector('[data-testid="terminal-panel"] .xterm-rows');
    return rows?.textContent?.includes('/theme');
  }, undefined, { timeout: 20_000 });
  await page.waitForTimeout(750);
  const stableThemeText = await terminalText();
  assert.equal(stableThemeText.includes('/theme'), true);
  assert.match(stableThemeText, /choose a syntax highlighting theme/i);
  const directInputFrames = terminalInputFrames.slice(directInputFrameStart);
  results.directTheme = {
    terminalOpened: true,
    draftClearedAfterAck: await (await composer()).inputValue() === '',
    autoSubmitted: directInputFrames.some(({ data }) => /[\r\n]/.test(data)),
    protocolRepliesObserved: directInputFrames.length > 0,
  };
  assert.deepEqual(results.directTheme, {
    terminalOpened: true,
    draftClearedAfterAck: true,
    autoSubmitted: false,
    protocolRepliesObserved: true,
  });
  await screenshot('08-terminal-direct-theme-prefill.png');
  await terminal.getByRole('button', { name: 'Close terminal' }).click();
  await terminal.waitFor({ state: 'detached', timeout: 10_000 });

  const forkInputFrameStart = terminalInputFrames.length;
  await command('/fork');
  await terminal.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const rows = document.querySelector('[data-testid="terminal-panel"] .xterm-rows');
    return /['"]?codex['"]?\s+['"]?fork['"]?\s+['"]?[0-9a-f-]{36}['"]?/i.test(rows?.textContent ?? '');
  }, undefined, { timeout: 20_000 });
  await page.waitForTimeout(750);
  const stableForkText = await terminalText();
  const forkInputFrames = terminalInputFrames.slice(forkInputFrameStart);
  results.directFork = {
    verifiedThreadPrefilled: forkPrefillPattern.test(stableForkText),
    draftClearedAfterAck: await (await composer()).inputValue() === '',
    autoSubmitted: forkInputFrames.some(({ data }) => /[\r\n]/.test(data)),
  };
  assert.deepEqual(results.directFork, {
    verifiedThreadPrefilled: true,
    draftClearedAfterAck: true,
    autoSubmitted: false,
  });
  await screenshot('09-terminal-direct-fork-prefill.png');
  await terminal.getByRole('button', { name: 'Close terminal' }).click();
  await terminal.waitFor({ state: 'detached', timeout: 10_000 });
  await page.waitForTimeout(500);

  const handoffInputFrameStart = terminalInputFrames.length;
  await command('/review');
  await terminal.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const rows = document.querySelector('[data-testid="terminal-panel"] .xterm-rows');
    const text = rows?.textContent ?? '';
    return text.includes('UI_E2E_READY') && text.includes('/review');
  }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(750);
  const stableReviewText = await terminalText();
  const handoffInputFrames = terminalInputFrames.slice(handoffInputFrameStart);
  const blockedArchiveResponse = await page.request.patch(
    `${new URL(appUrl).origin}/api/sessions/${sessionId}/archive`,
    { data: { archived: true } },
  );
  const blockedArchiveBody = await blockedArchiveResponse.json();
  results.handoffReview = {
    priorThreadResumed: stableReviewText.includes('UI_E2E_READY'),
    reviewPrefilled: stableReviewText.includes('/review'),
    draftClearedAfterAck: await (await composer()).inputValue() === '',
    autoSubmitted: handoffInputFrames.some(({ data }) => /[\r\n]/.test(data)),
    archiveBlockedWith409: blockedArchiveResponse.status() === 409
      && blockedArchiveBody.code === 'session_handed_off_to_terminal',
  };
  assert.deepEqual(results.handoffReview, {
    priorThreadResumed: true,
    reviewPrefilled: true,
    draftClearedAfterAck: true,
    autoSubmitted: false,
    archiveBlockedWith409: true,
  });
  await screenshot('10-terminal-handoff-review-prefill.png');
  await terminal.getByRole('button', { name: 'Close terminal' }).click();

  results.messageHistoryUnchanged = await messageCount() === initialMessageCount;
  assert.equal(results.messageHistoryUnchanged, true);

  console.log(JSON.stringify({ appUrl, outputDir, results }, null, 2));
} catch (error) {
  await screenshot('99-failure.png').catch(() => undefined);
  console.error(JSON.stringify({ terminalInputFrames }, null, 2));
  throw error;
} finally {
  await browser.close();
}
