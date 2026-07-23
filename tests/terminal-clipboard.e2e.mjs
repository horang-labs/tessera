import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const port = Number(process.env.TESSERA_E2E_PORT ?? 3199);
const appOrigin = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-clipboard-e2e-'));
const serverOutput = [];
let uploadedImagePath = null;
let electronApp = null;

const server = spawn('npm', ['run', 'dev'], {
  cwd: process.cwd(),
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    TESSERA_DATA_DIR: dataDir,
    TESSERA_ELECTRON_AUTH_BYPASS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput.push(chunk.toString());
    if (serverOutput.length > 200) serverOutput.shift();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Tessera server exited early:\n${serverOutput.join('')}`);
    }
    try {
      const response = await fetch(`${appOrigin}/dev-terminal-scroll-repro`);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Tessera server did not start:\n${serverOutput.join('')}`);
}

async function registerTestProject() {
  const settingsResponse = await fetch(`${appOrigin}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(
    settingsResponse.ok,
    true,
    `failed to configure the E2E environment (${settingsResponse.status}): ${await settingsResponse.text()}`,
  );
  const response = await fetch(`${appOrigin}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folderPath: process.cwd() }),
  });
  assert.equal(
    response.ok,
    true,
    `failed to register the E2E project (${response.status}): ${await response.text()}`,
  );
}

async function takePtyInput(page) {
  return page.evaluate(() => (
    window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput() ?? []
  ));
}

async function waitForPtyInput(page, predicate) {
  const captured = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    captured.push(...await takePtyInput(page));
    if (predicate(captured.join(''))) return captured.join('');
    await page.waitForTimeout(50);
  }
  return captured.join('');
}

async function stopServer() {
  if (server.exitCode !== null || server.killed) return;
  if (process.platform === 'win32') {
    server.kill('SIGTERM');
    return;
  }
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

try {
  await waitForServer();
  await registerTestProject();
  electronApp = await electron.launch({
    args: ['dist-electron/electron/main.js'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      TESSERA_DATA_DIR: dataDir,
      TESSERA_DEV_PORT: String(port),
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
    },
  });

  const page = await electronApp.firstWindow();
  page.on('console', (message) => serverOutput.push(`[renderer:${message.type()}] ${message.text()}\n`));
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));
  await page.goto(`${appOrigin}/dev-terminal-scroll-repro`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  try {
    await page.getByTestId('terminal-repro-status').getByText('running').waitFor({
      timeout: 30_000,
    });
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '<body unavailable>');
    throw new Error(
      `Terminal did not start. Page contents:\n${body}\nLogs:\n${serverOutput.join('')}`,
      { cause: error },
    );
  }
  const terminalInput = page.locator('.xterm-helper-textarea');
  await terminalInput.focus();
  assert.equal(
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.capturePtyInput()),
    true,
  );

  const copyMarker = `TESSERA_COPY_SELECTION_${Date.now()}`;
  assert.equal(
    await page.evaluate((marker) => (
      window.__tesseraTerminalScrollRepro?.writeOutput(`\r\n${marker}\r\n`)
    ), copyMarker),
    true,
  );
  const selectedText = await page.evaluate((marker) => (
    window.__tesseraTerminalScrollRepro?.selectText(marker) ?? ''
  ), copyMarker);
  assert.equal(selectedText, copyMarker, 'the copy regression requires a visible terminal selection');
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('stale clipboard text'));
  await takePtyInput(page);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(250);
  assert.equal(
    await electronApp.evaluate(({ clipboard }) => clipboard.readText()),
    selectedText,
    'Ctrl+C with a terminal selection must copy the selected text',
  );
  assert.equal(
    (await takePtyInput(page)).join('').includes('\x03'),
    false,
    'Ctrl+C with a terminal selection must not interrupt the PTY',
  );

  await electronApp.evaluate(({ clipboard }) => clipboard.writeText('stale explicit copy'));
  await page.keyboard.press('Control+Shift+C');
  await page.waitForTimeout(250);
  assert.equal(
    await electronApp.evaluate(({ clipboard }) => clipboard.readText()),
    selectedText,
    'Ctrl+Shift+C must explicitly copy the terminal selection',
  );
  assert.equal(
    (await takePtyInput(page)).join(''),
    '',
    'Ctrl+Shift+C must not emit PTY input',
  );
  await page.evaluate(() => window.__tesseraTerminalScrollRepro?.clearSelection());
  await takePtyInput(page);
  await page.keyboard.press('Control+C');
  const interruptInput = await waitForPtyInput(page, (input) => input.includes('\x03'));
  assert.equal(
    interruptInput.includes('\x03'),
    true,
    'Ctrl+C without a terminal selection must still interrupt the PTY',
  );

  const marker = `TESSERA_CLIPBOARD_TEXT_${Date.now()}`;
  await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), marker);
  await takePtyInput(page);
  await page.keyboard.press('Control+V');
  const textInput = await waitForPtyInput(page, (input) => input.includes(marker));
  assert.equal(textInput.split(marker).length - 1, 1, 'clipboard text must be pasted exactly once');
  assert.equal(textInput.includes('\x16'), false, 'Ctrl+V must not reach the PTY as a control key');

  await electronApp.evaluate(({ clipboard }) => clipboard.clear());
  await takePtyInput(page);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(250);
  assert.equal((await takePtyInput(page)).join(''), '', 'an empty clipboard must not emit PTY input');

  await electronApp.evaluate(({ clipboard, nativeImage }) => {
    const bitmap = Buffer.from([0x00, 0x00, 0xff, 0xff]);
    clipboard.writeImage(nativeImage.createFromBitmap(bitmap, {
      width: 1,
      height: 1,
      scaleFactor: 1,
    }));
  });
  const imageClipboardState = await electronApp.evaluate(({ clipboard }) => {
    const image = clipboard.readImage();
    return {
      isEmpty: image.isEmpty(),
      pngBytes: image.toPNG().byteLength,
      size: image.getSize(),
      text: clipboard.readText(),
    };
  });
  assert.equal(
    imageClipboardState.isEmpty,
    false,
    `Electron did not retain the test image: ${JSON.stringify(imageClipboardState)}`,
  );
  await takePtyInput(page);
  await page.keyboard.press('Control+V');
  const imageInput = await waitForPtyInput(page, (input) => input.includes('clipboard-image.png'));
  const imagePathMatch = imageInput.match(/(\/tmp\/tessera-uploads\/[^\x1b\r\n]+clipboard-image\.png)/);
  assert.ok(
    imagePathMatch,
    `image paste must emit its uploaded path, received ${JSON.stringify(imageInput)}; `
      + `clipboard=${JSON.stringify(imageClipboardState)}; page=${await page.locator('body').innerText()}; `
      + `logs=${serverOutput.join('')}`,
  );
  uploadedImagePath = imagePathMatch[1];
  assert.equal(imageInput.split('clipboard-image.png').length - 1, 1, 'image path must be pasted exactly once');
  assert.equal(imageInput.includes('\x16'), false, 'image paste must not emit a Ctrl+V control key');
} finally {
  await electronApp?.close().catch(() => {});
  await stopServer();
  if (uploadedImagePath) await fs.rm(uploadedImagePath, { force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
}
