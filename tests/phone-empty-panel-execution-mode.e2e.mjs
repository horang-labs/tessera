// The new-tab Agent UI selector must show both complete labels at the Phone viewport.
// A source-level absence of `truncate` is not enough: a nowrap child can still overflow a
// flex item and be clipped by the panel. Measure the rendered text box at the largest user
// font scale, where the selector has the least spare width.

import assert from 'node:assert/strict';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { startPhoneAppServer } from './helpers/phone-app-server.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';

const MAX_FONT_SCALE = 1.375;

const app = await startPhoneAppServer({ name: 'empty-panel-execution-mode' });
let browser;

try {
  await app.setFontScale(MAX_FONT_SCALE);
  browser = await launchPhoneBrowser();
  const context = await createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });

  try {
    const page = await app.preparePage(context);
    await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
    await page.getByTestId('chat-layout').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('tab-bar-add').click();
    await page.getByTestId('empty-panel-state').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-empty-panel-execution-mode]')
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(300);

    const labels = await page.evaluate(() => (
      ['pty', 'gui'].map((mode) => {
        const option = document.querySelector(`[data-testid="execution-mode-${mode}"]`);
        const text = option?.querySelector('span > span');
        const group = option?.closest('[role="radiogroup"]');
        if (!(option instanceof HTMLElement) || !(text instanceof HTMLElement) || !(group instanceof HTMLElement)) {
          return { mode, missing: true };
        }
        const textRect = text.getBoundingClientRect();
        const optionRect = option.getBoundingClientRect();
        const groupRect = group.getBoundingClientRect();
        return {
          mode,
          missing: false,
          text: text.textContent?.trim(),
          clientWidth: text.clientWidth,
          scrollWidth: text.scrollWidth,
          textLeft: textRect.left,
          textRight: textRect.right,
          optionLeft: optionRect.left,
          optionRight: optionRect.right,
          groupLeft: groupRect.left,
          groupRight: groupRect.right,
        };
      })
    ));

    assert.deepEqual(
      labels.map(({ text }) => text),
      ['Terminal (PTY)', 'Tessera Chat (GUI)'],
      `the selector must render the full labels: ${JSON.stringify(labels)}`,
    );
    for (const label of labels) {
      assert.equal(label.missing, false, `missing ${label.mode} option: ${JSON.stringify(label)}`);
      assert.ok(
        label.scrollWidth <= label.clientWidth + 1
          && label.textLeft >= label.optionLeft - 1
          && label.textRight <= label.optionRight + 1
          && label.textLeft >= label.groupLeft - 1
          && label.textRight <= label.groupRight + 1,
        `${label.text} is clipped at the Phone viewport: ${JSON.stringify(label)}`,
      );
    }
  } finally {
    await context.close();
  }
} catch (error) {
  const logs = app.logs();
  if (logs) process.stderr.write(`\n--- isolated server output ---\n${logs.slice(-20_000)}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await app.stop();
}

console.log('phone empty-panel execution-mode labels passed');
