async page => {
  const origin = await page.evaluate(() => location.origin);

  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('project-strip-/home/work/Source/browser-operator').waitFor({
    timeout: 60_000,
  });
  await page.getByTestId('project-strip-/home/work/Source/browser-operator').click();

  const sidebarToggle = page.getByTestId('tab-bar-sidebar-toggle');
  if (await sidebarToggle.getAttribute('aria-label') === 'Expand sidebar') {
    await sidebarToggle.click();
  }

  await page.getByText('Mobile PTY workflow', { exact: true }).first().waitFor({
    timeout: 30_000,
  });
  await page.getByText('Mobile GUI workflow', { exact: true }).first().waitFor({
    timeout: 30_000,
  });

  // Start the real isolated Codex PTY before recording. A brand-new safe repo
  // always presents the trust prompt on first TUI launch.
  await page.getByText('Mobile PTY workflow', { exact: true }).first().click();
  const terminalInput = page.getByTestId('terminal-input-bar-textarea');
  await terminalInput.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await terminalInput.fill('1');
  await page.getByTestId('terminal-input-bar-send').click();
  await page.getByTestId('terminal-input-bar-key-enter').click();
  await page.waitForTimeout(8_000);

  if (await page.getByTestId('terminal-chat-overlay').isVisible().catch(() => false)) {
    await page.getByTestId('terminal-view-toggle').click();
  }

  if (await sidebarToggle.getAttribute('aria-label') === 'Expand sidebar') {
    await sidebarToggle.click();
  }
  await page.getByText('Mobile PTY workflow', { exact: true }).first().waitFor();
}
