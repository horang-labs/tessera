#!/usr/bin/env node

const { chromium } = require('@playwright/test');

async function moveCursor(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cursor target is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
}

async function cursorClick(page, locator) {
  await moveCursor(page, locator);
  await locator.click();
  await page.waitForTimeout(300);
}

async function ensureSidebarCollapsed(page) {
  const toggle = page.getByTestId('sidebar-collapse-btn');
  if ((await toggle.getAttribute('aria-label')) === 'Collapse sidebar') {
    await toggle.click();
    await page.waitForTimeout(500);
  }
}

async function ensureSidebarExpanded(page) {
  const toggle = page.getByTestId('tab-bar-sidebar-toggle');
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(500);
  }
}

async function closeOtherTabs(page, keepTitle) {
  const closeButtons = page.locator('button[aria-label^="Close tab:"]');
  for (let index = (await closeButtons.count()) - 1; index >= 0; index -= 1) {
    const button = closeButtons.nth(index);
    const label = await button.getAttribute('aria-label');
    if (label === `Close tab: ${keepTitle}`) continue;
    await button.click();
    await page.waitForTimeout(250);
  }
}

async function closeRightPanelIfOpen(page) {
  const filesTab = page.locator('button[title="Files"]');
  if (await filesTab.isVisible().catch(() => false)) {
    await page.getByTestId('tab-bar-git-toggle').click();
    await page.waitForTimeout(500);
  }
}

async function openSession(page, title) {
  const closeNewTab = page.getByRole('button', { name: 'Close tab: New Tab' });
  if (await closeNewTab.count()) await closeNewTab.click();
  await page.getByText(title, { exact: true }).filter({ visible: true }).first().click();
  await page.waitForTimeout(2_000);
}

async function recordPtyChatView(page, outputPath) {
  await closeRightPanelIfOpen(page);
  await ensureSidebarExpanded(page);
  await openSession(page, 'PTY to Chat View');
  await closeOtherTabs(page, 'PTY to Chat View');
  await ensureSidebarCollapsed(page);
  const toggle = page.getByTestId('terminal-view-toggle').filter({ visible: true }).last();
  if ((await toggle.getAttribute('aria-label')) === 'Back to terminal') {
    await toggle.click();
    await page.waitForTimeout(700);
  }
  const terminalSurface = page.locator('.xterm-link-layer').filter({ visible: true }).last();
  await terminalSurface.hover();
  await page.mouse.wheel(0, -1_400);
  await page.waitForTimeout(700);
  await page.screencast.start({ path: outputPath, size: { width: 1400, height: 900 } });
  await page.waitForTimeout(2_000);
  await cursorClick(page, toggle);
  await page.getByTestId('terminal-chat-overlay').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_700);
  const composer = page.getByTestId('terminal-chat-composer-input');
  await moveCursor(page, composer);
  await composer.click();
  await composer.pressSequentially('Turn the checks into a helper.', { delay: 52 });
  await page.waitForTimeout(500);
  await cursorClick(page, page.getByTestId('terminal-chat-composer-send'));
  await page.waitForTimeout(4_200);
  await page.screencast.stop();
}

async function seedPtyAdvertisingConversation(page) {
  await closeRightPanelIfOpen(page);
  await ensureSidebarExpanded(page);
  await openSession(page, 'PTY to Chat View');
  await ensureSidebarCollapsed(page);
  const toggle = page.getByTestId('terminal-view-toggle').filter({ visible: true }).last();
  if ((await toggle.getAttribute('aria-label')) !== 'Back to terminal') {
    await toggle.click();
    await page.getByTestId('terminal-chat-overlay').waitFor({ timeout: 10_000 });
  }
  const cancel = page.getByTestId('terminal-chat-cancel');
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.waitFor({ state: 'hidden', timeout: 90_000 });
  }
  const composer = page.getByTestId('terminal-chat-composer-input');
  await composer.fill('Give exactly 12 one-line checks for reliable Playwright actions. Keep each under seven words.');
  await page.getByTestId('terminal-chat-composer-send').click();
  await cancel.waitFor({ state: 'visible', timeout: 10_000 });
  await cancel.waitFor({ state: 'hidden', timeout: 90_000 });
  await page.waitForTimeout(1_000);
}

async function openDemoNotesInFiles(page) {
  await ensureSidebarExpanded(page);
  await openSession(page, 'Add demo feature');
  await closeOtherTabs(page, 'Add demo feature');
  await ensureSidebarCollapsed(page);
  await closeRightPanelIfOpen(page);
  await page.getByTestId('tab-bar-git-toggle').click();
  await page.waitForTimeout(450);
  const filesTab = page.locator('button[title="Files"]');
  if (!(await page.getByTestId('workspace-file-tree').isVisible().catch(() => false))) {
    await filesTab.click();
    await page.waitForTimeout(450);
  }
  await page.getByTestId('workspace-file-row-demo-notes.md').click();
  await page.waitForTimeout(650);
  const sourceTab = page.getByRole('tab', { name: 'Source' });
  if ((await sourceTab.getAttribute('aria-selected')) !== 'true') {
    await sourceTab.click();
  }
  await page.locator('.monaco-editor').waitFor({ state: 'visible', timeout: 10_000 });
}

async function replaceEditorContent(page, content) {
  const editor = page.locator('.monaco-editor').filter({ visible: true }).last();
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(content);
  await page.getByTestId('workspace-file-save').click();
  await page.waitForTimeout(900);
}

async function seedFileStory(page) {
  await openDemoNotesInFiles(page);
  await replaceEditorContent(page, [
    '# Reliable Playwright clicks',
    '',
    '- Prefer role-based locators.',
    '- Wait for the target to be visible.',
    '- Keep retries bounded and observable.',
    '',
  ].join('\n'));
}

async function recordFileGitWorkflow(page, outputPath) {
  await openDemoNotesInFiles(page);
  process.stderr.write('file-git: prepared Files view\n');
  await page.locator('button[title="Git"]').click();
  await page.waitForTimeout(450);
  const checkbox = page.getByTestId('git-commit-file-checkbox-demo-notes.md');
  await checkbox.waitFor({ timeout: 10_000 });
  if (await checkbox.isChecked()) await checkbox.uncheck();
  await page.getByTestId('git-commit-message').fill('');
  await page.locator('button[title="Files"]').click();
  await page.waitForTimeout(450);
  await page.screencast.start({ path: outputPath, size: { width: 1400, height: 900 } });
  process.stderr.write('file-git: recording started\n');
  await page.waitForTimeout(1_200);
  const editor = page.locator('.monaco-editor').filter({ visible: true }).last();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('- Capture a screenshot when a retry times out.', { delay: 25 });
  await page.waitForTimeout(300);
  await cursorClick(page, page.getByTestId('workspace-file-save'));
  process.stderr.write('file-git: edit saved\n');
  await page.waitForTimeout(400);
  await cursorClick(page, page.locator('button[title="Git"]'));
  process.stderr.write('file-git: Git panel opened\n');
  await page.waitForTimeout(450);
  await cursorClick(page, page.getByTestId('git-panel-file-row-demo-notes.md').locator('button').first());
  process.stderr.write('file-git: diff opened\n');
  await page.waitForTimeout(650);
  await cursorClick(page, checkbox);
  process.stderr.write('file-git: file selected\n');
  const message = page.getByTestId('git-commit-message');
  await moveCursor(page, message);
  await message.click();
  await message.pressSequentially('docs: clarify retry guidance', { delay: 38 });
  await page.waitForTimeout(300);
  await cursorClick(page, page.getByTestId('git-action-menu-trigger'));
  process.stderr.write('file-git: action ladder opened\n');
  await page.waitForTimeout(1_800);
  await page.screencast.stop();
}

async function main() {
  const [command, cdpUrl, commandArg] = process.argv.slice(2);
  if (!command || !cdpUrl) {
    throw new Error('Usage: node scripts/readme-demo-electron.cjs <command> <cdp-url> [argument]');
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error('Electron renderer page not found');
    page.setDefaultTimeout(8_000);

    if (command === 'setup' && new URL(page.url()).pathname === '/setup') {
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.waitForURL('**/chat', { timeout: 30_000 });
    } else if (command === 'reset') {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } else if (command === 'screenshot') {
      if (!commandArg) throw new Error('screenshot requires an output path');
      await page.screenshot({ path: commandArg });
    } else if (command === 'open-session') {
      if (!commandArg) throw new Error('open-session requires a session title');
      const closeNewTab = page.getByRole('button', { name: 'Close tab: New Tab' });
      if (await closeNewTab.count()) await closeNewTab.click();
      const session = page.getByText(commandArg, { exact: true }).filter({ visible: true }).first();
      await session.click();
      await page.waitForTimeout(5_000);
    } else if (command === 'click-test-id') {
      if (!commandArg) throw new Error('click-test-id requires a data-testid');
      await page.getByTestId(commandArg).click();
      await page.waitForTimeout(1_000);
    } else if (command === 'click-text') {
      if (!commandArg) throw new Error('click-text requires visible text');
      await page.getByText(commandArg, { exact: true }).filter({ visible: true }).last().click();
      await page.waitForTimeout(1_000);
    } else if (command === 'click-button') {
      if (!commandArg) throw new Error('click-button requires an accessible name');
      await page.getByRole('button', { name: commandArg, exact: true }).filter({ visible: true }).last().click();
      await page.waitForTimeout(1_000);
    } else if (command === 'side-tab') {
      if (!commandArg) throw new Error('side-tab requires a title');
      await page.locator(`button[title="${commandArg}"]`).click();
      await page.waitForTimeout(1_000);
    } else if (command === 'create-pty-session') {
      await page.getByTestId('empty-panel-mode-chat').click();
      await page.getByTestId('provider-chip-codex').click();
      await page.getByText('Terminal (PTY)', { exact: true }).click();
      await page.getByTestId('empty-panel-create-session').click();
      await page.getByTestId('terminal-container').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(3_000);
    } else if (command === 'seed-pty-session') {
      const titleHandle = page.getByTestId('panel-title-drag-handle').filter({ visible: true }).last();
      await titleHandle.click();
      const titleInput = page.locator('input').filter({ visible: true }).last();
      await titleInput.fill('PTY to Chat View');
      await titleInput.press('Enter');
      const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
      await terminalInput.fill('Answer in exactly three short bullets: why can a Playwright click fail until a button is visible?');
      await terminalInput.press('Enter');
      await page.waitForTimeout(30_000);
    } else if (command === 'prepare-pty') {
      const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
      await terminalInput.click();
      await terminalInput.press('Enter');
      await page.waitForTimeout(12_000);
      await terminalInput.press('Control+l');
      await page.waitForTimeout(1_000);
      await terminalInput.fill('Answer in exactly three short bullets: why can a Playwright click fail until a button is visible?');
      await terminalInput.press('Enter');
      await page.waitForTimeout(30_000);
    } else if (command === 'terminal-enter') {
      const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
      await terminalInput.click();
      await terminalInput.press('Enter');
      await page.waitForTimeout(30_000);
    } else if (command === 'record-pty') {
      if (!commandArg) throw new Error('record-pty requires an output path');
      await recordPtyChatView(page, commandArg);
    } else if (command === 'seed-pty-advert') {
      await seedPtyAdvertisingConversation(page);
    } else if (command === 'seed-file-story') {
      await seedFileStory(page);
    } else if (command === 'record-file-git') {
      if (!commandArg) throw new Error('record-file-git requires an output path');
      await recordFileGitWorkflow(page, commandArg);
    } else if (command !== 'inspect') {
      throw new Error(`Unknown command: ${command}`);
    }

    const result = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      },
      text: document.body.innerText.slice(0, 4_000),
      terminalText: document.querySelector('.xterm-rows')?.textContent?.slice(-4_000) ?? '',
      controls: Array.from(document.querySelectorAll('button, [role="button"], input, textarea'))
        .slice(0, 250)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.getAttribute('placeholder') || '').trim().slice(0, 120),
          ariaLabel: element.getAttribute('aria-label'),
          title: element.getAttribute('title'),
          testId: element.getAttribute('data-testid'),
        })),
    }));
    result.cookies = (await page.context().cookies()).map(({ name, domain, httpOnly, secure }) => ({
      name,
      domain,
      httpOnly,
      secure,
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
