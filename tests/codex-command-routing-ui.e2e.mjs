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
const appOrigin = new URL(appUrl).origin;

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

async function composer(targetSessionId = sessionId) {
  const input = page.locator(`textarea[data-session-input=${JSON.stringify(targetSessionId)}]`);
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  return input;
}

async function openSession(targetSessionId) {
  const input = page.locator(`textarea[data-session-input=${JSON.stringify(targetSessionId)}]`);
  const sidebarEntry = page.locator(
    `[data-session-id=${JSON.stringify(targetSessionId)}]`,
  ).first();
  if (await sidebarEntry.count() > 0) {
    await sidebarEntry.waitFor({ state: 'visible', timeout: 30_000 });
    await sidebarEntry.click();
  }
  return composer(targetSessionId);
}

async function activeSessionId() {
  const input = page.locator('textarea[data-session-input]:visible').first();
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  return input.getAttribute('data-session-input');
}

async function command(value, targetSessionId = sessionId) {
  const input = await openSession(targetSessionId);
  await input.fill(value);
  await input.press('Enter');
  return input;
}

async function messages(targetSessionId = sessionId) {
  const response = await page.request.get(
    `${appOrigin}/api/sessions/${targetSessionId}/messages?limit=500`,
  );
  assert.equal(response.ok(), true, `messages API returned ${response.status()}`);
  const payload = await response.json();
  assert.equal(Array.isArray(payload.messages), true);
  return payload.messages;
}

async function messageCount(targetSessionId = sessionId) {
  return (await messages(targetSessionId)).length;
}

async function sessionRecord(targetSessionId) {
  const response = await page.request.get(`${appOrigin}/api/sessions/projects`);
  assert.equal(response.ok(), true, `projects API returned ${response.status()}`);
  const payload = await response.json();
  return payload.projects
    .flatMap((project) => project.sessions)
    .find((session) => session.id === targetSessionId);
}

async function waitForSessionTitle(targetSessionId, expectedTitle) {
  await page.waitForFunction(async ({ origin, targetSessionId, expectedTitle }) => {
    const response = await fetch(`${origin}/api/sessions/projects`);
    const payload = await response.json();
    return payload.projects
      .flatMap((project) => project.sessions)
      .some((session) => session.id === targetSessionId && session.title === expectedTitle);
  }, {
    origin: appOrigin,
    targetSessionId,
    expectedTitle,
  }, { timeout: 30_000 });
}

async function terminalText() {
  return (await page.locator('[data-testid="terminal-panel"] .xterm-rows').textContent()) ?? '';
}

try {
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
  await openSession(sessionId);
  const initialMessageCount = await messageCount();
  const initialSessionTitle = (await sessionRecord(sessionId))?.title;
  assert.equal(typeof initialSessionTitle, 'string');

  const input = await composer();
  await input.fill('/');
  const picker = page.getByRole('listbox');
  await picker.waitFor({ timeout: 10_000 });
  const forkOption = page.getByRole('option', { name: /\/fork/ });
  const deleteOption = page.getByRole('option', { name: /\/delete/ });
  const usageOption = page.getByRole('option', { name: /\/usage/ });
  await forkOption.waitFor({ timeout: 10_000 });
  await deleteOption.waitFor({ timeout: 10_000 });
  await usageOption.waitFor({ timeout: 10_000 });
  results.picker = {
    forkNative: !/terminal/i.test((await forkOption.textContent()) ?? ''),
    deleteNative: !/terminal/i.test((await deleteOption.textContent()) ?? ''),
    usageTerminal: /terminal/i.test((await usageOption.textContent()) ?? ''),
    themeHidden: await page.getByRole('option', { name: /\/theme/ }).count() === 0,
    windowsCommandHidden: await page.getByRole('option', { name: /\/setup-default-sandbox/ }).count() === 0,
  };
  assert.deepEqual(results.picker, {
    forkNative: true,
    deleteNative: true,
    usageTerminal: true,
    themeHidden: true,
    windowsCommandHidden: true,
  });
  await screenshot('01-command-picker-routes.png');
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
  const visiblePlanToggle = page.locator('[data-testid="plan-mode-toggle"]:visible').first();
  await visiblePlanToggle.waitFor({ timeout: 10_000 });
  results.planModeActivated = await visiblePlanToggle.getAttribute('aria-pressed') === 'true';
  assert.equal(results.planModeActivated, true);
  await screenshot('04-native-plan-mode.png');
  await visiblePlanToggle.click();

  const temporaryTitle = `${initialSessionTitle} (E2E Rename)`;
  await command(`/rename ${temporaryTitle}`);
  await waitForSessionTitle(sessionId, temporaryTitle);
  results.renameSynced = true;
  await screenshot('05-native-rename-synced.png');
  let restoreRenameResponse;
  const restoreRenameDeadline = Date.now() + 30_000;
  do {
    restoreRenameResponse = await page.request.patch(
      `${appOrigin}/api/sessions/${sessionId}/rename`,
      { data: { title: initialSessionTitle } },
    );
    if (restoreRenameResponse.ok()) break;
    assert.equal(restoreRenameResponse.status(), 409);
    await page.waitForTimeout(100);
  } while (Date.now() < restoreRenameDeadline);
  assert.equal(restoreRenameResponse?.ok(), true, 'failed to restore the source title');
  await waitForSessionTitle(sessionId, initialSessionTitle);

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

  await command('/theme');
  results.hiddenTheme = {
    terminalCount: await page.getByTestId('terminal-panel').count(),
    draftPreserved: await (await composer()).inputValue() === '/theme',
  };
  assert.deepEqual(results.hiddenTheme, {
    terminalCount: 0,
    draftPreserved: true,
  });
  await screenshot('07-hidden-theme-blocked.png');
  await (await composer()).fill('');

  const directInputFrameStart = terminalInputFrames.length;
  const directInput = await composer();
  await directInput.fill('/mc');
  await picker.waitFor({ timeout: 10_000 });
  await page.getByRole('option', { name: /\/mcp/ }).click();
  const terminal = page.getByTestId('terminal-panel');
  await terminal.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const rows = document.querySelector('[data-testid="terminal-panel"] .xterm-rows');
    return rows?.textContent?.includes('/mcp');
  }, undefined, { timeout: 20_000 });
  await page.waitForTimeout(750);
  const stableMcpText = await terminalText();
  assert.equal(stableMcpText.includes('/mcp'), true);
  const directInputFrames = terminalInputFrames.slice(directInputFrameStart);
  results.directMcp = {
    terminalOpened: true,
    draftClearedAfterAck: await (await composer()).inputValue() === '',
    autoSubmitted: directInputFrames.some(({ data }) => /[\r\n]/.test(data)),
    protocolRepliesObserved: directInputFrames.length > 0,
  };
  assert.deepEqual(results.directMcp, {
    terminalOpened: true,
    draftClearedAfterAck: true,
    autoSubmitted: false,
    protocolRepliesObserved: true,
  });
  await screenshot('08-terminal-direct-mcp-prefill.png');
  await terminal.getByRole('button', { name: 'Close terminal' }).click();
  await terminal.waitFor({ state: 'detached', timeout: 10_000 });

  const forkInputFrameStart = terminalInputFrames.length;
  await command('/fork');
  await page.waitForFunction((sourceId) => {
    const input = [...document.querySelectorAll('textarea[data-session-input]')]
      .find((element) => element.getClientRects().length > 0);
    return input?.getAttribute('data-session-input') !== sourceId;
  }, sessionId, { timeout: 30_000 });
  const forkedSessionId = await activeSessionId();
  assert.ok(forkedSessionId);
  assert.notEqual(forkedSessionId, sessionId);
  const forkedMessages = await messages(forkedSessionId);
  results.nativeFork = {
    newSessionOpened: true,
    terminalCount: await page.getByTestId('terminal-panel').count(),
    terminalInputFrames: terminalInputFrames.length - forkInputFrameStart,
    historyCountMatches: forkedMessages.length === initialMessageCount,
    markerCloned: JSON.stringify(forkedMessages).includes('UI_E2E_READY'),
    composerEmpty: await (await composer(forkedSessionId)).inputValue() === '',
    sourcePanelCount: await page.locator(
      `textarea[data-session-input=${JSON.stringify(sessionId)}]`,
    ).count(),
    childPanelCount: await page.locator(
      `textarea[data-session-input=${JSON.stringify(forkedSessionId)}]`,
    ).count(),
  };
  assert.deepEqual(results.nativeFork, {
    newSessionOpened: true,
    terminalCount: 0,
    terminalInputFrames: 0,
    historyCountMatches: true,
    markerCloned: true,
    composerEmpty: true,
    sourcePanelCount: 1,
    childPanelCount: 1,
  });
  await screenshot('09-native-fork-new-tab.png');
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
  await composer(forkedSessionId);
  results.nativeForkReloadPreserved = {
    childPanelCount: await page.locator(
      `textarea[data-session-input=${JSON.stringify(forkedSessionId)}]`,
    ).count(),
    sourceHistoryAvailable: await messageCount(sessionId) === initialMessageCount,
  };
  assert.deepEqual(results.nativeForkReloadPreserved, {
    childPanelCount: 1,
    sourceHistoryAvailable: true,
  });
  await openSession(sessionId);
  await openSession(forkedSessionId);

  const handoffInputFrameStart = terminalInputFrames.length;
  await command('/review', forkedSessionId);
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
    `${appOrigin}/api/sessions/${forkedSessionId}/archive`,
    { data: { archived: true } },
  );
  const blockedArchiveBody = await blockedArchiveResponse.json();
  results.handoffReview = {
    priorThreadResumed: stableReviewText.includes('UI_E2E_READY'),
    reviewPrefilled: stableReviewText.includes('/review'),
    draftClearedAfterAck: await (await composer(forkedSessionId)).inputValue() === '',
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
  await terminal.waitFor({ state: 'detached', timeout: 10_000 });

  await command('/delete', forkedSessionId);
  const deleteDialog = page.getByTestId('delete-session-dialog');
  await deleteDialog.waitFor({ timeout: 10_000 });
  results.nativeDeleteCancel = {
    dialogOpened: true,
    terminalCount: await page.getByTestId('terminal-panel').count(),
    childStillExists: (await messageCount(forkedSessionId)) === initialMessageCount,
  };
  assert.deepEqual(results.nativeDeleteCancel, {
    dialogOpened: true,
    terminalCount: 0,
    childStillExists: true,
  });
  await screenshot('11-native-delete-confirmation.png');
  await page.getByTestId('delete-session-cancel').click();
  await deleteDialog.waitFor({ state: 'detached', timeout: 10_000 });

  await command('/delete', forkedSessionId);
  await deleteDialog.waitFor({ timeout: 10_000 });
  await page.getByTestId('delete-session-confirm').click();
  await page.waitForFunction(async ({ origin, childId }) => {
    const response = await fetch(`${origin}/api/sessions/projects`);
    const payload = await response.json();
    return !payload.projects
      .flatMap((project) => project.sessions)
      .some((session) => session.id === childId);
  }, { origin: appOrigin, childId: forkedSessionId }, { timeout: 30_000 });
  results.nativeDeleteConfirmed = true;
  await screenshot('12-native-delete-completed.png');

  results.sourceMessageHistoryUnchanged = await messageCount(sessionId) === initialMessageCount;
  assert.equal(results.sourceMessageHistoryUnchanged, true);

  console.log(JSON.stringify({ appUrl, outputDir, results }, null, 2));
} catch (error) {
  await screenshot('99-failure.png').catch(() => undefined);
  console.error(JSON.stringify({ terminalInputFrames }, null, 2));
  throw error;
} finally {
  await browser.close();
}
