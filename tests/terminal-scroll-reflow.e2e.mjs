import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-terminal-scroll-repro';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

async function terminalMetrics() {
  return page.evaluate(() => {
    const metrics = window.__tesseraTerminalScrollRepro?.metrics();
    return metrics ? {
      clientHeight: metrics.rows,
      scrollHeight: metrics.baseY + metrics.rows,
      scrollTop: metrics.viewportY,
    } : null;
  });
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

async function loseTerminalWebglContext() {
  return page.evaluate(() => {
    for (const canvas of document.querySelectorAll('.xterm-screen canvas')) {
      try {
        const context = canvas.getContext('webgl2');
        const extension = context?.getExtension('WEBGL_lose_context');
        if (!extension) continue;
        extension.loseContext();
        return true;
      } catch {
        // The DOM renderer canvas does not expose a WebGL context.
      }
    }
    return false;
  });
}

async function terminalSurfaceBounds() {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="terminal-scroll-repro"]');
    const screen = host?.querySelector('.xterm-screen');
    if (!host || !screen) return null;
    const hostRect = host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    return {
      hostRight: hostRect.right,
      hostBottom: hostRect.bottom,
      screenRight: screenRect.right,
      screenBottom: screenRect.bottom,
    };
  });
}

async function waitForScrollbackRows(minimumRows) {
  await page.waitForFunction((minimum) => (
    (window.__tesseraTerminalScrollRepro?.metrics()?.baseY ?? 0) > minimum
  ), minimumRows, { timeout: 30_000 });
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
  assert.equal(
    await page.getByTestId('terminal-scrollbar').count(),
    0,
    'terminal must not mirror scroll position through a separate React scrollbar',
  );

  const longRows = `node -e "for(let i=1;i<=450;i++){const tag='ROW_'+String(i).padStart(4,'0');console.log((tag+' abcdefghijklmnopqrstuvwxyz ').repeat(8))}"`;
  await typeCommand(longRows);
  await waitForScrollbackRows(100);

  await page.waitForTimeout(2_500);
  const scrollbar = page.locator(
    '.xterm-scrollable-element > .xterm-scrollbar.xterm-vertical',
  );
  const scrollbarSlider = page.locator(
    '.xterm-scrollable-element > .xterm-scrollbar.xterm-vertical > .xterm-slider',
  );
  await scrollbarSlider.waitFor({ state: 'attached', timeout: 1_000 });
  const idleScrollbarStyle = await scrollbar.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    pointerEvents: getComputedStyle(element).pointerEvents,
  }));
  assert.equal(idleScrollbarStyle.opacity, '0', 'xterm must auto-hide the scrollbar while idle');
  assert.equal(idleScrollbarStyle.pointerEvents, 'none', 'an auto-hidden scrollbar must not intercept input');

  await page.locator('.xterm-scrollable-element').hover();
  await page.waitForFunction(() => {
    const element = document.querySelector(
      '.xterm-scrollable-element > .xterm-scrollbar.xterm-vertical',
    );
    return element && getComputedStyle(element).opacity !== '0';
  });
  const hoveredScrollbarStyle = await scrollbarSlider.evaluate((element) => ({
    opacity: getComputedStyle(element.parentElement).opacity,
    visibility: getComputedStyle(element).visibility,
    width: element.getBoundingClientRect().width,
  }));
  assert.notEqual(hoveredScrollbarStyle.opacity, '0', 'xterm must reveal scrollback controls on hover');
  assert.notEqual(hoveredScrollbarStyle.visibility, 'hidden', 'hovered scrollbar must remain visible');
  assert.ok(hoveredScrollbarStyle.width > 0, 'terminal scrollbar must reserve a usable gutter');

  const thumbBeforeWheel = await scrollbarSlider.boundingBox();
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -600);
  const thumbAfterWheel = await scrollbarSlider.boundingBox();
  assert.ok(
    thumbBeforeWheel && thumbAfterWheel && thumbAfterWheel.y < thumbBeforeWheel.y,
    'xterm-owned scrollbar thumb must move in the same wheel interaction',
  );
  const jumpButton = page.getByTestId('terminal-scroll-to-bottom-button');
  await jumpButton.waitFor({ state: 'visible', timeout: 5_000 });
  await jumpButton.click();
  await jumpButton.waitFor({ state: 'hidden', timeout: 5_000 });

  let metrics = await terminalMetrics();
  assert.ok(metrics, 'terminal row metrics should be available');
  assert.ok(
    metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2,
    'new terminal output should remain attached to the bottom',
  );

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Shift+PageUp');
  await page.keyboard.press('Shift+PageUp');
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

  const contextLossTag = await firstVisibleRowTag();
  const didLoseWebglContext = await loseTerminalWebglContext();
  if (didLoseWebglContext) {
    await page.waitForTimeout(500);
    const fallbackBounds = await terminalSurfaceBounds();
    assert.ok(fallbackBounds, 'terminal bounds should be measurable after WebGL context loss');
    assert.ok(
      fallbackBounds.screenRight <= fallbackBounds.hostRight + 1,
      `DOM fallback must fit horizontally inside its host (overflow: ${fallbackBounds.screenRight - fallbackBounds.hostRight}px)`,
    );
    assert.ok(
      fallbackBounds.screenBottom <= fallbackBounds.hostBottom + 1,
      `DOM fallback must fit vertically inside its host (overflow: ${fallbackBounds.screenBottom - fallbackBounds.hostBottom}px)`,
    );
    assert.equal(
      await firstVisibleRowTag(),
      contextLossTag,
      'renderer fallback should preserve the first visible scrollback row',
    );
  } else {
    assert.equal(
      process.env.TESSERA_E2E_ALLOW_NO_WEBGL,
      '1',
      'WebGL2 context-loss coverage is required; set TESSERA_E2E_ALLOW_NO_WEBGL=1 only on unsupported runners',
    );
    console.warn('WebGL context-loss coverage explicitly skipped: WebGL2 is unavailable');
  }

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
