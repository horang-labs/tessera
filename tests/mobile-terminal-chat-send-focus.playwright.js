// Run via playwright-cli -s=<persistent-mobile-session> run-code --filename=<this file>.
// Requires a disposable, ready PTY chat session in a touch-enabled mobile context.
async page => {
  const input = page.getByTestId('terminal-chat-composer-input');
  await input.tap();
  await input.fill('UI focus check: reply OK only. Do not use tools or modify files.');
  await page.getByTestId('terminal-chat-composer-send').tap();
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="terminal-chat-composer-input"]');
    return input && !input.disabled;
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await input.evaluate(el => document.activeElement === el)) {
    throw new Error('Mobile composer regained focus after sending');
  }
  if (await input.inputValue()) throw new Error('Send was not accepted; draft remains');
  await input.tap();
  if (!await input.evaluate(el => document.activeElement === el)) {
    throw new Error('Explicit tap must still focus the composer');
  }
  await input.blur();
  return 'PASS: send dismisses focus; explicit tap can restore it';
}
