// Ticket #243 — a phone can type into a PTY session through the Terminal input bar.
//
// What this file cannot cover, and what no green run here should be read as: Playwright
// raises no real soft keyboard. Whether tapping the bar summons the Android Chrome
// keyboard, and whether the bar then rides above it under #245's
// `interactive-widget=resizes-content`, are device-only. They are the acceptance criteria
// that matter most and they are settled by holding a phone, not by this suite.
//
// What is provable headlessly is the other half: that the bar is in the tree at a Phone
// viewport and absent above one, and that typed text and each of the six keys leave the
// browser addressed to that terminal as the exact bytes. The seam is the outgoing
// WebSocket frame — the last point the browser owns before the bytes are the server's,
// and the closest a browser test gets to the PTY. It is captured by wrapping
// `WebSocket.prototype.send` from an init script rather than through a hook in
// application code, so the test observes the real wire and cannot be satisfied by a
// fixture written for it. What happens to those bytes after the socket is the terminal
// manager's own tested ground, not this file's.
//
// The server runs from the repository itself, not from a copy of the app root: a copy
// generates no Tailwind utilities, and an unstyled page would make every layout
// measurement here meaningless (harness trap #252).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

// Wide enough to be an ordinary desktop window, and well clear of the 640px Phone
// viewport boundary the bar is conditional on.
const DESKTOP_VIEWPORT = { width: 1000, height: 900 };
const REPRO_TERMINAL_ID = 'dev-terminal-input-bar-repro';

// The six keys and the bytes a keyboard would put on the wire for each. Written out as
// literals on purpose: importing them from the module under test would make this assert
// that the code equals itself.
const KEY_SEQUENCES = [
  ['escape', '\x1b'],
  ['shift-tab', '\x1b[Z'],
  ['up', '\x1b[A'],
  ['down', '\x1b[B'],
  ['enter', '\r'],
  ['ctrl-c', '\x03'],
];

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-input-bar-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

const BROWSER_USER_ID = 'e2e-input-bar-user';

// The account the browser's cookie names. Written before the server starts, because the
// request gate looks the token's subject up in this file and an Electron-runtime server
// creates no account of its own. A cookie rather than a header because `extraHTTPHeaders`
// never reaches a WebSocket upgrade — and the WebSocket is the seam under test.
await writeBrowserUser();

const server = spawn(
  process.execPath,
  ['./node_modules/.bin/tsx', 'server.ts'],
  {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

server.stdout.on('data', (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});
server.stderr.on('data', (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
});

let browser;
let appSecret;
try {
  appSecret = await waitForServer(`${appOrigin}/api/settings`, server);

  browser = await chromium.launch({ headless: true });
  await testTheBarIsPresentAtAPhoneViewport(browser, appOrigin);
  await testTheBarIsAbsentFromTheDesktopTree(browser, appOrigin);
  await testSubmittedTextLeavesForThePtyBracketedPasteWrapped(browser, appOrigin);
  await testEachKeyLeavesForThePtyAsItsOwnSequence(browser, appOrigin);
  await testCtrlCLeavesForThePtyWithNoInterveningDialog(browser, appOrigin);
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- isolated server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (server.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // The isolated server may already have exited after a startup failure.
    }
  }
  await waitForExit(server, 5_000);
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log('mobile terminal input bar e2e passed');

// -------------------------------------------------------------------- bar ---

async function testTheBarIsPresentAtAPhoneViewport(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await page.getByTestId('terminal-input-bar').waitFor({ timeout: 30_000 });

    const barBox = await page.getByTestId('terminal-input-bar').boundingBox();
    assert.ok(barBox, 'the bar should be measurable at a Phone viewport');
    assert.ok(
      barBox.x >= -1 && barBox.x + barBox.width <= PHONE_VIEWPORT.width + 1,
      `the bar must fit the width of the screen`
        + ` (left ${barBox.x}px, right ${barBox.x + barBox.width}px)`,
    );

    // Every control has to be tappable, which is the reason the key set is six and not
    // nineteen. A control that overflows the screen is the send-button defect again.
    for (const [namedKey] of KEY_SEQUENCES) {
      const keyBox = await page.getByTestId(`terminal-input-bar-key-${namedKey}`).boundingBox();
      assert.ok(keyBox, `the ${namedKey} key should be measurable`);
      assert.ok(
        keyBox.width >= 44 && keyBox.height >= 44,
        `the ${namedKey} key must be a 44px touch target`
          + ` (${Math.round(keyBox.width)}x${Math.round(keyBox.height)})`,
      );
      assert.ok(
        keyBox.x >= -1 && keyBox.x + keyBox.width <= PHONE_VIEWPORT.width + 1,
        `the ${namedKey} key must be on screen`
          + ` (left ${keyBox.x}px, right ${keyBox.x + keyBox.width}px)`,
      );
    }

    // The whole reason the bar exists: a real element a tap can focus, unlike xterm's
    // helper textarea. Focus is not the soft keyboard — that part is device-only — but a
    // tap that does not even move focus could never raise one.
    await page.getByTestId('terminal-input-bar-textarea').tap();
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null),
      'terminal-input-bar-textarea',
      'tapping the bar must focus a real, tappable input element',
    );
  } finally {
    await context.close();
  }
}

// D3 is a conditional render, not `display: none`: absent from the tree is the assertion,
// because a hidden-but-present bar is a desktop regression waiting to be styled back in.
async function testTheBarIsAbsentFromTheDesktopTree(browserInstance, origin) {
  const context = await browserInstance.newContext({
    viewport: DESKTOP_VIEWPORT,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addCookies(await browserCookies());
  const page = await context.newPage();

  try {
    await openRepro(page, origin);

    assert.equal(
      await page.getByTestId('terminal-input-bar').count(),
      0,
      'the bar must not be in the tree at a desktop viewport',
    );
    assert.equal(
      await page.getByTestId('terminal-input-bar-textarea').count(),
      0,
      'no part of the bar may survive on a desktop, hidden or otherwise',
    );
  } finally {
    await context.close();
  }
}

// -------------------------------------------------------------------- pty ---

async function testSubmittedTextLeavesForThePtyBracketedPasteWrapped(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await takeTerminalInput(page);

    await page.getByTestId('terminal-input-bar-textarea').fill('run the tests');
    await page.getByTestId('terminal-input-bar-send').tap();

    assert.equal(
      await waitForTerminalInput(page),
      '\x1b[200~run the tests\x1b[201~',
      'submitted text must go out to the PTY wrapped in bracketed paste',
    );
    assert.equal(
      await page.getByTestId('terminal-input-bar-textarea').inputValue(),
      '',
      'a delivered submit should leave the bar empty for the next one',
    );
  } finally {
    await context.close();
  }
}

async function testEachKeyLeavesForThePtyAsItsOwnSequence(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);

    for (const [namedKey, sequence] of KEY_SEQUENCES) {
      await takeTerminalInput(page);
      await page.getByTestId(`terminal-input-bar-key-${namedKey}`).tap();

      assert.equal(
        await waitForTerminalInput(page),
        sequence,
        `the ${namedKey} key must go out to the PTY as ${JSON.stringify(sequence)}`,
      );
    }
  } finally {
    await context.close();
  }
}

// Ctrl+C answers a session that has stopped answering Esc. A dialog in front of it costs
// the taps the user does not have, so the absence of one is the criterion, not an
// omission.
async function testCtrlCLeavesForThePtyWithNoInterveningDialog(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await takeTerminalInput(page);

    await page.getByTestId('terminal-input-bar-key-ctrl-c').tap();

    assert.equal(
      await waitForTerminalInput(page),
      '\x03',
      'Ctrl+C must go out to the PTY on the first tap',
    );
    assert.equal(
      await page.locator('[role="dialog"], [role="alertdialog"]').count(),
      0,
      'nothing may stand between the Ctrl+C tap and the PTY',
    );
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------- page ---

async function writeBrowserUser() {
  const now = new Date().toISOString();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'users.json'),
    JSON.stringify({
      users: [{
        id: BROWSER_USER_ID,
        username: 'e2e',
        passwordHash: 'unused',
        createdAt: now,
        lastLoginAt: now,
      }],
    }, null, 2),
    'utf8',
  );
}

async function browserCookies() {
  const privateKey = await fs.readFile(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
  const token = jwt.sign(
    { sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
    privateKey,
    { algorithm: 'RS256', expiresIn: 3600 },
  );
  return [{ name: 'jwt', value: token, domain: '127.0.0.1', path: '/', sameSite: 'Lax' }];
}

async function createPhonePage(browserInstance) {
  const context = await createPhoneContext(browserInstance, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addCookies(await browserCookies());
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    serverOutput = `${serverOutput}[renderer:error] ${error.stack ?? error.message}\n`.slice(-20_000);
  });
  return { context, page };
}

async function openRepro(page, origin) {
  await page.addInitScript(captureTerminalInputFrames, REPRO_TERMINAL_ID);
  // 'load' rather than 'domcontentloaded': the touch-target measurements below are
  // styled measurements, and an unstyled button measures as its text.
  await page.goto(`${origin}/dev-terminal-input-bar-repro`, {
    waitUntil: 'load',
    timeout: 60_000,
  });
  await page.getByTestId('terminal-panel').waitFor({ timeout: 60_000 });
  // The `agentation` feedback toolbar is a development-only tool the layout mounts, not
  // part of the product, and at 360px it parks itself over the bar's send button. Hiding
  // it keeps this test measuring Tessera rather than the tooling around it.
  await page.addStyleTag({ content: '[data-agentation-root] { display: none !important; }' });
  // The bar writes over the socket, so an open socket has to exist before any send can
  // be observed. The application only sends when the socket reports OPEN, so a frame
  // already on the wire for this terminal is the proof — no connection-state store is
  // consulted, which keeps this test independent of how that state is reported.
  await page.waitForFunction(
    () => (window.__tesseraTerminalFrames?.sentCount() ?? 0) > 0,
    { timeout: 60_000 },
  );
}

// Runs before any application script: replaces `WebSocket.prototype.send` so every
// `terminal_input` frame addressed to this terminal is recorded as it goes out.
function captureTerminalInputFrames(terminalId) {
  const input = [];
  let sentForTerminal = 0;
  const originalSend = WebSocket.prototype.send;

  WebSocket.prototype.send = function send(data) {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message?.terminalId === terminalId) {
          sentForTerminal += 1;
          if (message.type === 'terminal_input') input.push(message.data);
        }
      } catch {
        // Not every frame this application sends is JSON worth reading.
      }
    }
    return originalSend.call(this, data);
  };

  window.__tesseraTerminalFrames = {
    sentCount: () => sentForTerminal,
    take: () => input.splice(0, input.length),
  };
}

async function takeTerminalInput(page) {
  await page.evaluate(() => window.__tesseraTerminalFrames?.take());
}

/** The bytes sent to the PTY since the last `takeTerminalInput`. */
async function waitForTerminalInput(page) {
  const captured = await page.waitForFunction(
    () => {
      const frames = window.__tesseraTerminalFrames?.take() ?? [];
      return frames.length === 0 ? null : frames.join('');
    },
    { timeout: 10_000 },
  );
  return captured.jsonValue();
}

// ---------------------------------------------------------------- server ---

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  if (await Promise.race([exited, timedOut]) !== 'timeout') return;
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process exited between the timeout and the forced cleanup.
    }
  }
  await exited;
}

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const selectedPort = address.port;
  await new Promise((resolve, reject) => listener.close((error) => (
    error ? reject(error) : resolve()
  )));
  return selectedPort;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated Tessera server exited with code ${child.exitCode}`);
    }
    try {
      const secret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(url, {
        headers: { 'x-tessera-app-secret': secret },
      });
      if (response.ok) return secret;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for isolated Tessera server at ${url}`);
}
