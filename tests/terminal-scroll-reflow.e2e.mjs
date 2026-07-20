import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-terminal-scroll-repro';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

async function terminalMetrics() {
  return page.locator('.xterm-viewport').evaluate((viewport) => ({
    clientHeight: viewport.clientHeight,
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
  }));
}

async function firstVisibleRowTag() {
  return page.evaluate(() => window.__tesseraTerminalScrollRepro?.firstVisibleRowTag() ?? null);
}

async function terminalViewportY() {
  return page.evaluate(() => window.__tesseraTerminalScrollRepro?.viewportY() ?? null);
}

async function terminalIsAtBottom() {
  return page.evaluate(() => window.__tesseraTerminalScrollRepro?.isAtBottom() ?? null);
}

async function waitForScrollHeight(minimumHeight) {
  await page.waitForFunction((minimum) => (
    (document.querySelector('.xterm-viewport')?.scrollHeight ?? 0) > minimum
  ), minimumHeight, { timeout: 30_000 });
}

async function typeCommand(command) {
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByTestId('terminal-repro-status').getByText('running').waitFor({ timeout: 30_000 });
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached', timeout: 30_000 });
  const persistentScrollbar = page.getByTestId('terminal-scrollbar');
  await persistentScrollbar.waitFor({ state: 'visible', timeout: 5_000 });
  await page.waitForTimeout(1_000);
  assert.equal(
    await persistentScrollbar.isVisible(),
    true,
    'terminal scrollbar should remain visible while the terminal is idle',
  );

  const longRows = `node -e "for(let i=1;i<=450;i++){const tag='ROW_'+String(i).padStart(4,'0');console.log((tag+' abcdefghijklmnopqrstuvwxyz ').repeat(8))}"`;
  await typeCommand(longRows);
  await waitForScrollHeight(5_000);

  const scrollbarTrack = await persistentScrollbar.boundingBox();
  const scrollbarThumb = await page.getByTestId('terminal-scrollbar-thumb').boundingBox();
  assert.ok(scrollbarTrack && scrollbarThumb, 'persistent scrollbar geometry should be measurable');
  assert.ok(
    scrollbarThumb.height < scrollbarTrack.height,
    'scrollback should produce a position thumb smaller than its track',
  );

  let metrics = await terminalMetrics();
  assert.ok(
    metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2,
    'new terminal output should remain attached to the bottom',
  );

  await page.keyboard.press('Shift+PageUp');
  await page.keyboard.press('Shift+PageUp');
  const jumpButton = page.getByTestId('terminal-scroll-to-bottom-button');
  await jumpButton.waitFor({ state: 'visible', timeout: 5_000 });
  const pinnedMetrics = await terminalMetrics();
  assert.ok(pinnedMetrics.scrollTop > 0, 'the test should pin inside scrollback, not at the top');
  const pinnedTag = await firstVisibleRowTag();
  assert.ok(pinnedTag, 'a tagged scrollback row should be visible before reflow');

  await page.setViewportSize({ width: 720, height: 800 });
  await page.waitForTimeout(300);
  const afterReflow = await terminalMetrics();
  assert.ok(
    afterReflow.scrollTop > 0
      && afterReflow.scrollTop + afterReflow.clientHeight < afterReflow.scrollHeight - 2,
    'width reflow should keep the viewport pinned inside scrollback',
  );
  assert.equal(
    await firstVisibleRowTag(),
    pinnedTag,
    'width reflow should keep the same first visible output row',
  );

  const beforeBackgroundOutput = await terminalMetrics();
  const backgroundRows = `node -e "let i=451;const id=setInterval(()=>{console.log('ROW_'+String(i).padStart(4,'0')+' background-output');if(i++>=520)clearInterval(id)},10)"`;
  await typeCommand(backgroundRows);
  await page.keyboard.press('Shift+PageUp');
  await page.waitForTimeout(1200);
  const afterBackgroundOutput = await terminalMetrics();
  assert.ok(
    afterBackgroundOutput.scrollHeight > beforeBackgroundOutput.scrollHeight,
    'background output should extend scrollback',
  );
  assert.ok(
    afterBackgroundOutput.scrollTop + afterBackgroundOutput.clientHeight
      < afterBackgroundOutput.scrollHeight - 2,
    'background output must not pull a pinned viewport to the bottom',
  );

  const beforeViewChange = await firstVisibleRowTag();
  assert.ok(beforeViewChange, 'a tagged row should remain visible before remounting');
  await page.getByTestId('toggle-terminal-view').click();
  await page.getByTestId('toggle-terminal-view').click();
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached', timeout: 5_000 });
  await page.waitForTimeout(300);
  assert.equal(
    await firstVisibleRowTag(),
    beforeViewChange,
    'unmounting and remounting the terminal view should preserve scrollback position',
  );

  await jumpButton.click();
  await jumpButton.waitFor({ state: 'hidden', timeout: 5_000 });
  assert.equal(await terminalIsAtBottom(), true, 'the jump overlay should return to live output');

  if (process.platform === 'darwin') {
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Meta+ArrowUp');
    await jumpButton.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await terminalViewportY(), 0, 'Cmd+Up should jump to scrollback top');
    await page.keyboard.press('Meta+ArrowDown');
  }
  await jumpButton.waitFor({ state: 'hidden', timeout: 5_000 });
  assert.equal(await terminalIsAtBottom(), true, 'Cmd+Down should return to live output');
} finally {
  await page.getByTestId('close-terminal-repro').click().catch(() => {});
  await browser.close();
}
