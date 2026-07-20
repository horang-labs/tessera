import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-terminal-scroll-repro';
const claudeBin = process.env.TESSERA_E2E_CLAUDE_BIN ?? 'claude';
const claudeCheck = spawnSync(claudeBin, ['--version'], { encoding: 'utf8' });
if (claudeCheck.error?.code === 'ENOENT') {
  console.warn(`Claude resize E2E skipped: ${claudeBin} is not installed`);
  process.exit(0);
}
assert.equal(
  claudeCheck.status,
  0,
  `Claude resize E2E requires a runnable Claude CLI: ${claudeCheck.stderr}`,
);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

async function terminalBackgroundRgb() {
  return page.locator('.xterm-scrollable-element').evaluate((element) => {
    const match = getComputedStyle(element).backgroundColor.match(
      /^rgba?\((\d+),\s*(\d+),\s*(\d+)/,
    );
    if (!match) throw new Error('Unable to resolve terminal background color');
    return match.slice(1, 4).map(Number);
  });
}

async function topViewportContentPixels(background) {
  const screenshot = await page.locator('.xterm-screen').screenshot();
  const { data, info } = await sharp(screenshot)
    .extract({ left: 0, top: 0, width: 500, height: 120 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (
      Math.max(
        Math.abs(data[offset] - background[0]),
        Math.abs(data[offset + 1] - background[1]),
        Math.abs(data[offset + 2] - background[2]),
      ) > 25
    ) {
      count += 1;
    }
  }
  return count;
}

async function terminalUsesWebgl() {
  return page.evaluate(() => {
    for (const canvas of document.querySelectorAll('.xterm-screen canvas')) {
      try {
        if (canvas.getContext('webgl2')) return true;
      } catch {
        // DOM renderer canvases reject WebGL context access.
      }
    }
    return false;
  });
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
  assert.equal(await terminalUsesWebgl(), true, 'resize regression requires the WebGL renderer');

  await typeCommand(
    `node -e "for(let i=0x2500;i<0x2c00;i++){process.stdout.write('\\x1b[3'+(i%8)+'m'+String.fromCodePoint(i)+(i%64===0?'\\n':''))}process.stdout.write('\\x1b[0m\\n')"`,
  );
  await page.waitForTimeout(500);
  await typeCommand(claudeBin);
  await page.waitForFunction(
    () => window.__tesseraTerminalScrollRepro?.bufferType() === 'alternate',
    { timeout: 15_000 },
  );
  assert.equal(
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.bufferType()),
    'alternate',
    'Claude must replace the seeded normal-buffer glyphs with its alternate screen',
  );
  assert.equal(
    await terminalUsesWebgl(),
    true,
    'Claude alternate screen must still be rendered by WebGL before resize',
  );
  await page.waitForTimeout(500);
  const background = await terminalBackgroundRgb();
  const contentBeforeResize = await topViewportContentPixels(background);
  assert.ok(contentBeforeResize > 300, 'Claude alternate buffer must render visible content');

  await page.setViewportSize({ width: 760, height: 800 });
  await page.waitForTimeout(300);
  for (let index = 0; index < 24; index += 1) {
    await page.setViewportSize({
      width: index % 2 === 0 ? 1180 : 760,
      height: index % 3 === 0 ? 620 : 800,
    });
    await page.waitForTimeout(20);
  }

  const contentAfterResize = await topViewportContentPixels(background);
  assert.ok(
    contentAfterResize >= contentBeforeResize * 0.5,
    `Claude alternate buffer must remain painted after resize (${contentAfterResize}/${contentBeforeResize} content pixels)`,
  );
} finally {
  await page.getByTestId('close-terminal-repro').click().catch(() => {});
  await browser.close();
}
