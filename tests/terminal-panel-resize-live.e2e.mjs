import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-terminal-scroll-repro';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

async function typeCommand(command) {
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function reportedPtyColumns() {
  const text = await page.evaluate(
    () => window.__tesseraTerminalScrollRepro?.visibleText() ?? '',
  );
  const match = text.match(/PTY_COLS_(\d+)/);
  return match ? Number(match[1]) : null;
}

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByTestId('terminal-repro-status').getByText('running').waitFor({
    timeout: 30_000,
  });
  await page.getByTestId('toggle-terminal-split').click();
  await page.getByTestId('terminal-split-container').waitFor();
  await page.locator('.xterm-helper-textarea').waitFor({
    state: 'attached',
    timeout: 30_000,
  });

  await typeCommand(
    `node -e "process.stdout.write('\\x1b[?1049h\\x1b[2J');const draw=()=>process.stdout.write('\\x1b[H\\x1b[2KPTY_COLS_'+process.stdout.columns);process.stdout.on('resize',draw);draw();setInterval(()=>{},1000)"`,
  );
  await page.waitForFunction(
    () => /PTY_COLS_\d+/.test(window.__tesseraTerminalScrollRepro?.visibleText() ?? ''),
    { timeout: 10_000 },
  );
  const initialColumns = await reportedPtyColumns();
  assert.ok(initialColumns && initialColumns > 60, 'test terminal must start wide');

  const divider = page.getByTestId('panel-divider');
  const bounds = await divider.boundingBox();
  assert.ok(bounds, 'split divider must be measurable');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 260, bounds.y + bounds.height / 2, { steps: 5 });

  await page.waitForFunction(
    (previous) => {
      const text = window.__tesseraTerminalScrollRepro?.visibleText() ?? '';
      const match = text.match(/PTY_COLS_(\d+)/);
      return match ? Number(match[1]) < previous - 10 : false;
    },
    initialColumns,
    { timeout: 2_000 },
  );
  assert.ok(
    (await reportedPtyColumns()) < initialColumns - 10,
    'PTY must receive the narrower grid before the divider is released',
  );
  await page.mouse.up();
} finally {
  await page.mouse.up().catch(() => {});
  await page.getByTestId('close-terminal-repro').click().catch(() => {});
  await browser.close();
}
