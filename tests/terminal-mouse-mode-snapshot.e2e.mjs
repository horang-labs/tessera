import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Regression e2e for the "Claude PTY opens with dead wheel scroll until a
// keypress" bug: a cold-reattach snapshot replay used to restore the mouse
// tracking protocol (?1000h) but drop the SGR report encoding (?1006h), so
// xterm downgraded wheel reports to legacy X10 bytes that mouse-reporting
// TUIs ignore. This drives the real dev server + WebSocket + headless
// snapshot path with a PTY that enables the same modes Claude Code does.
const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-terminal-scroll-repro';

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

async function waitForTerminalRunning() {
  await page.getByTestId('terminal-repro-status').getByText('running').waitFor({ timeout: 30_000 });
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached', timeout: 30_000 });
}

async function repro(method) {
  return page.evaluate((name) => window.__tesseraTerminalScrollRepro?.[name](), method);
}

async function wheelReportsFromPty() {
  await page.evaluate(() => window.__tesseraTerminalScrollRepro?.capturePtyInput());
  await page.evaluate(() => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput());
  const screen = page.locator('.xterm-screen');
  await screen.hover();
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  const captured = await page.evaluate(
    () => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput() ?? [],
  );
  return captured.join('');
}

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForTerminalRunning();

  // Enable the exact modes Claude Code asserts: tracking + SGR encoding.
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type("printf '\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h'");
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__tesseraTerminalScrollRepro?.mouseReporting() === true,
    { timeout: 10_000 },
  );

  const liveReports = await wheelReportsFromPty();
  assert.match(
    liveReports,
    /\x1b\[<6[45];\d+;\d+M/,
    `live TUI wheel must produce SGR-encoded reports, got ${JSON.stringify(liveReports)}`,
  );

  // Cold reattach: reload replays the server headless-model snapshot.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForTerminalRunning();
  await page.waitForFunction(
    () => window.__tesseraTerminalScrollRepro?.mouseReporting() === true,
    { timeout: 10_000 },
  );

  const replayedReports = await wheelReportsFromPty();
  assert.doesNotMatch(
    replayedReports,
    /\x1b\[M/,
    `snapshot replay must not downgrade wheel reports to legacy X10 encoding, got ${JSON.stringify(replayedReports)}`,
  );
  assert.match(
    replayedReports,
    /\x1b\[<6[45];\d+;\d+M/,
    `snapshot replay must preserve SGR wheel reports, got ${JSON.stringify(replayedReports)}`,
  );

  console.log('mouse-mode snapshot e2e passed');
} finally {
  await page.evaluate(() => {
    // Leave the repro PTY clean for the next run.
    window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput();
  }).catch(() => {});
  await page.getByTestId('close-terminal-repro').click().catch(() => {});
  await browser.close();
}
