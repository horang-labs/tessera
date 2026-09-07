// Run with playwright-cli -s=<persistent-mobile-session> run-code --filename=tests/mobile-task-menu-dismissal.playwright.js
// Precondition: an open PTY session in a touch-enabled browser, either a panel or Kanban Peek.
async page => {
  const menu = page.getByRole('menu', { name: 'Task options' });
  const peek = page.getByTestId('kanban-session-peek');
  const surface = await peek.isVisible() ? peek : page.getByRole('tabpanel');
  const more = surface.getByTestId('header-more-button');
  if (await menu.count()) await page.keyboard.press('Escape');
  const terminalButton = surface.getByTestId('terminal-view-toggle').getByRole('button').first();
  if (await terminalButton.getAttribute('aria-pressed') !== 'true') await terminalButton.tap();

  await more.tap();
  if (!await menu.count()) throw new Error('Menu did not open');
  // Tap to the left of the right-aligned menu, on the real touch-handling PTY.
  await surface.locator('.xterm-screen').tap({ position: { x: 10, y: 150 } });
  if (await menu.count()) throw new Error('PTY tap did not dismiss the menu');

  await more.tap();
  if (!await menu.count()) throw new Error('Menu did not reopen');
  await more.tap();
  if (await menu.count()) throw new Error('More-button retap did not dismiss the menu');
  return 'PASS: PTY outside tap and trigger retap dismiss the menu';
}
