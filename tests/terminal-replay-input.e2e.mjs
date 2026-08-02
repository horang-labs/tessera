import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const appUrl = process.env.TESSERA_E2E_APP_URL
  ?? 'http://127.0.0.1:3100/dev-terminal-scroll-repro';
const cdpUrl = process.env.TESSERA_E2E_CDP_URL;
const browser = cdpUrl
  ? await chromium.connectOverCDP(cdpUrl)
  : await chromium.launch({ headless: true, channel: 'chrome' });
const context = cdpUrl
  ? browser.contexts()[0]
  : await browser.newContext({ viewport: { width: 1200, height: 800 } });
if (!context) throw new Error('Electron CDP connection has no browser context');
const page = cdpUrl ? context.pages()[0] : await context.newPage();
if (!page) throw new Error('Electron CDP connection has no renderer page');

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByTestId('terminal-repro-status').getByText('running').waitFor({
    timeout: 30_000,
  });
  const input = page.locator('.xterm-helper-textarea');
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  await input.focus();
  await page.keyboard.insertText(
    `node -e "process.stdin.setRawMode(true);process.stdin.resume();const draw=s=>process.stdout.write('\\x1b[H\\x1b[2K'+s);process.stdout.write('\\x1b[?1049h\\x1b[2J');draw('SELECT_1');let b='',timer=null;process.stdin.on('data',d=>{b=(b+d.toString()).slice(-128);if(/\\x1b\\[[0-9]+;[0-9]+R/.test(b)){draw('AUTO_REPLY_LEAK');b=''}else if(/\\x1b(?:\\[|O)B/.test(b)){draw('SELECT_2');b=''}else if(d.toString().includes('p')){clearInterval(timer);let col=1;timer=setInterval(()=>{col=col===1?10:1;process.stdout.write('\\x1b[2;'+col+'H')},30)}})"`,
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (
      (window.__tesseraTerminalScrollRepro?.visibleText() ?? '').split('\n')[0].trim()
      === 'SELECT_1'
    ),
    { timeout: 5_000 },
  );

  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
    true,
    'the browser must deliver keyboard events to xterm',
  );
  assert.equal(
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.capturePtyInput()),
    true,
    'the probe must observe xterm onData',
  );
  assert.equal(
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.replaySnapshot(
      '\x1b[?1049h\x1b[2J\x1b[HSELECT_1\x1b[6n',
    )),
    true,
    'the probe must enter the real terminal_snapshot handler',
  );
  await page.waitForFunction(
    () => (
      (window.__tesseraTerminalScrollRepro?.visibleText() ?? '').split('\n')[0].trim()
      === 'SELECT_1'
    ),
    { timeout: 2_000 },
  );
  await page.waitForTimeout(100);
  const replayAutoReplies = await page.evaluate(
    () => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput(),
  );
  assert.equal(
    replayAutoReplies?.some((data) => /^\x1b\[[0-9]+;[0-9]+R$/.test(data)),
    true,
    'the real xterm parser must generate a cursor-position auto-reply during replay',
  );
  assert.doesNotMatch(
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.visibleText() ?? ''),
    /AUTO_REPLY_LEAK/,
    'snapshot-generated auto-replies must not reach the live PTY',
  );

  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(
    () => (
      (window.__tesseraTerminalScrollRepro?.visibleText() ?? '').split('\n')[0].trim()
      === 'SELECT_2'
    ),
    { timeout: 750 },
  );
  const encodedInput = await page.evaluate(
    () => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput(),
  );
  assert.equal(encodedInput?.length, 1, 'ArrowDown must reach xterm onData exactly once');
  assert.match(
    encodedInput[0],
    /^\x1b(?:\[|O)B$/,
    'xterm must encode ArrowDown for normal or application cursor mode',
  );
  assert.doesNotMatch(
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.visibleText() ?? ''),
    /AUTO_REPLY_LEAK/,
  );

  // A busy TUI keeps repainting its input line while the OS IME owns the
  // composition. xterm normally follows the live terminal cursor; freezing
  // the helper textarea at compositionstart makes Korean text overwrite the
  // same visual position until the composition finally commits.
  await page.keyboard.insertText('p');
  await page.waitForTimeout(100);
  const imePositionSamples = await page.evaluate(async () => {
    const textarea = document.querySelector('.xterm-helper-textarea');
    const overlay = document.querySelector('.composition-view');
    if (!(textarea instanceof HTMLTextAreaElement) || !(overlay instanceof HTMLElement)) {
      throw new Error('xterm composition elements are missing');
    }

    textarea.focus();
    textarea.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
      data: '',
    }));
    textarea.value = '한';
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertCompositionText',
      data: '한',
      isComposing: true,
    }));
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
      bubbles: true,
      data: '한',
    }));

    const positions = [];
    for (let index = 0; index < 24; index += 1) {
      positions.push({
        textareaLeft: textarea.style.left,
        overlayLeft: overlay.style.left,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const compositionWasActive = overlay.classList.contains('active');
    textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '한',
    }));
    return { compositionWasActive, positions };
  });
  assert.equal(
    imePositionSamples.compositionWasActive,
    true,
    'the regression probe must sample an active IME composition',
  );
  assert.ok(
    new Set(imePositionSamples.positions.map((sample) => sample.textareaLeft)).size > 1,
    `IME helper must follow the moving TUI cursor instead of staying pinned: ${JSON.stringify(imePositionSamples.positions)}`,
  );
  assert.ok(
    new Set(imePositionSamples.positions.map((sample) => sample.overlayLeft)).size > 1,
    `IME overlay must follow the moving TUI cursor instead of staying pinned: ${JSON.stringify(imePositionSamples.positions)}`,
  );
} finally {
  await page.getByTestId('close-terminal-repro').click().catch(() => {});
  await browser.close();
}
