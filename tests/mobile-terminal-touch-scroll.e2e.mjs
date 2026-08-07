// Ticket #246 — a touch scroll must not inject arrow keys into the PTY.
//
// The defect is in the vendored xterm bundle, not in Tessera: with no wheel reporting
// requested and a buffer that has no scrollback (an alt screen), xterm converts touch
// scroll into ESC [ A / ESC [ B and writes one per cell of travel straight to the PTY.
// scripts/patch-xterm-touch-scroll.mjs removes that branch and only that branch.
//
// The seam is the byte stream leaving the terminal: `capturePtyInput()` subscribes to
// xterm's own onData, which is what the surface forwards to the PTY. Driving the buffer
// with `writeOutput()` instead of a live shell keeps the fixture exact — an alt screen
// with mouse reporting off is a state to put the terminal in, not a program to run — and
// it is the same bytes either way.
//
// The gesture is dispatched as real touch events through CDP, because xterm's gesture
// layer listens on the document for touchstart/touchmove/touchend and synthesizes its own
// events from them. Nothing less than real touch events reaches the code under test.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { createPhoneContext } from './helpers/phone-viewport.mjs';

// Both the raw form and the application-cursor-keys form the deleted branch could emit.
const ARROW_KEY_SEQUENCE = /\x1b(\[|O)[AB]/;
// SGR-encoded wheel reports: buttons 64 (up) and 65 (down).
const WHEEL_REPORT_SEQUENCE = /\x1b\[<6[45];\d+;\d+M/;

const run = promisify(execFile);
const PATCH_SCRIPT = 'scripts/patch-xterm-touch-scroll.mjs';
const BUNDLE_FILES = [
  'node_modules/@xterm/xterm/lib/xterm.mjs',
  'node_modules/@xterm/xterm/lib/xterm.js',
];

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-touch-scroll-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

const BROWSER_USER_ID = 'e2e-touch-scroll-user';

// The account the browser's cookie names. Written before the server starts, because the
// request gate looks the token's subject up in this file and an Electron-runtime server
// creates no account of its own. A cookie rather than a header because `extraHTTPHeaders`
// never reaches a WebSocket upgrade.
await writeBrowserUser();

// The server runs from the repository itself, not from a copy: the page under test is a
// dev-only route, and the bundle under test is this tree's node_modules.
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
  await testPatchLeavesAnAlreadyPatchedBundleAlone();
  await testPatchLeavesABundleWithoutTheTargetAlone();

  appSecret = await waitForServer(`${appOrigin}/api/settings`, server);

  browser = await chromium.launch({ headless: true });
  await testAltScreenTouchDragInjectsNoArrowKeys(browser, appOrigin);
  await testWheelReportingTouchDragStillReportsWheel(browser, appOrigin);
  await testScrollbackTouchDragStillScrollsTheViewport(browser, appOrigin);
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

console.log('mobile terminal touch-scroll e2e passed');

// ----------------------------------------------------------------- patch ---

// Idempotence. The bundles this repository installs are already patched, so a fixture cut
// from them is the state a second run meets, and a second run must change nothing.
async function testPatchLeavesAnAlreadyPatchedBundleAlone() {
  const fixture = await createBundleFixture((source) => source);

  try {
    for (const relative of BUNDLE_FILES) {
      assert.match(
        fixture.before.get(relative),
        /_handleTouchChange/,
        `${relative} should be the real bundle, or this proves nothing`,
      );
    }

    const { stdout } = await run(
      process.execPath,
      [path.join(repoRoot, PATCH_SCRIPT)],
      { cwd: fixture.dir },
    );

    for (const relative of BUNDLE_FILES) {
      assert.equal(
        await fs.readFile(path.join(fixture.dir, relative), 'utf8'),
        fixture.before.get(relative),
        `running the patch a second time must leave ${relative} byte-identical`,
      );
    }
    assert.doesNotMatch(
      stdout,
      /applied/,
      'the second run must recognise the patch as already applied, not skip it by accident',
    );
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
}

// The convention the precedent script establishes: an upgrade that renames or fixes the
// code upstream must leave the bundle untouched rather than half-rewritten. Renaming the
// handler is what such an upgrade looks like from the outside.
async function testPatchLeavesABundleWithoutTheTargetAlone() {
  const fixture = await createBundleFixture(
    (source) => source.replaceAll('_handleTouchChange', '_handleTouchGestureChange'),
  );

  try {
    const { stderr } = await run(
      process.execPath,
      [path.join(repoRoot, PATCH_SCRIPT)],
      { cwd: fixture.dir },
    );

    for (const relative of BUNDLE_FILES) {
      assert.equal(
        await fs.readFile(path.join(fixture.dir, relative), 'utf8'),
        fixture.before.get(relative),
        `a bundle without the target string must be left byte-identical: ${relative}`,
      );
    }
    assert.match(
      stderr,
      /not found/,
      'skipping a bundle it no longer recognises must be said out loud',
    );
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
}

async function createBundleFixture(transform) {
  const dir = await fs.mkdtemp(path.join(tempRoot, 'tessera-touch-scroll-bundle-'));
  const before = new Map();

  for (const relative of BUNDLE_FILES) {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = transform(await fs.readFile(path.join(repoRoot, relative), 'utf8'));
    await fs.writeFile(target, content, 'utf8');
    before.set(relative, content);
  }

  return { dir, before };
}

// ------------------------------------------------------------------- pty ---

// The reported symptom: a swipe over a TUI becomes history navigation, or prints [A / [B.
async function testAltScreenTouchDragInjectsNoArrowKeys(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await enterAltScreen(page);

    assert.equal(
      await repro(page, 'bufferType'),
      'alternate',
      'the fixture must put the terminal on an alt screen, the buffer without scrollback',
    );
    assert.equal(
      await repro(page, 'mouseReporting'),
      false,
      'the fixture must leave wheel reporting off, which is the branch under test',
    );

    const captured = await ptyInputDuringTouchDrag(page);

    assert.doesNotMatch(
      captured,
      ARROW_KEY_SEQUENCE,
      'a touch drag on an alt screen must not write arrow keys to the PTY,'
        + ` got ${JSON.stringify(captured)}`,
    );
  } finally {
    await context.close();
  }
}

// The working case, which the fix must not cost: a TUI that asked for wheel reporting is
// still told about the gesture. This is the branch ahead of the deleted one.
async function testWheelReportingTouchDragStillReportsWheel(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await enterAltScreen(page);
    // Tracking plus SGR encoding: the modes a mouse-reporting TUI asserts.
    await writeOutput(page, '\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    await page.waitForFunction(
      () => window.__tesseraTerminalScrollRepro?.mouseReporting() === true,
      { timeout: 15_000 },
    );

    const captured = await ptyInputDuringTouchDrag(page);

    assert.match(
      captured,
      WHEEL_REPORT_SEQUENCE,
      'a touch drag under wheel reporting must still send wheel reports,'
        + ` got ${JSON.stringify(captured)}`,
    );
    assert.doesNotMatch(
      captured,
      ARROW_KEY_SEQUENCE,
      `wheel reporting must not be mixed with arrow keys, got ${JSON.stringify(captured)}`,
    );
  } finally {
    await context.close();
  }
}

// The other branch the fix must not cost: an ordinary shell buffer with history behind it
// still scrolls under a finger, and still sends the PTY nothing at all.
async function testScrollbackTouchDragStillScrollsTheViewport(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await writeOutput(page, scrollbackFixture(200));

    assert.equal(
      await repro(page, 'bufferType'),
      'normal',
      'the fixture must stay on the normal buffer, the one that keeps scrollback',
    );
    const before = await repro(page, 'metrics');
    assert.ok(before && before.baseY > 0, `the fixture should produce scrollback, got ${JSON.stringify(before)}`);

    // A finger moving down drags the content down, so the viewport walks back into history.
    const captured = await ptyInputDuringTouchDrag(page, { deltaY: 240 });
    const after = await repro(page, 'metrics');

    assert.ok(
      after && after.viewportY < before.viewportY,
      'a touch drag on a buffer with scrollback must scroll the viewport'
        + ` (viewportY ${before?.viewportY} -> ${after?.viewportY})`,
    );
    assert.equal(
      captured,
      '',
      `scrolling scrollback must send the PTY nothing, got ${JSON.stringify(captured)}`,
    );
  } finally {
    await context.close();
  }
}

function scrollbackFixture(lineCount) {
  return Array.from(
    { length: lineCount },
    (_, index) => `ROW_${String(index).padStart(4, '0')}`,
  ).join('\r\n');
}

// ------------------------------------------------------------------ page ---

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

async function mintBrowserToken() {
  const privateKey = await fs.readFile(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
  return jwt.sign(
    { sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
    privateKey,
    { algorithm: 'RS256', expiresIn: 3600 },
  );
}

async function createPhonePage(browserInstance) {
  const context = await createPhoneContext(browserInstance, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  await context.addCookies([{
    name: 'jwt',
    value: await mintBrowserToken(),
    domain: '127.0.0.1',
    path: '/',
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    serverOutput = `${serverOutput}[renderer:error] ${error.stack ?? error.message}\n`.slice(-20_000);
  });
  return { context, page };
}

async function openRepro(page, origin) {
  await page.goto(`${origin}/dev-terminal-scroll-repro`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.locator('.xterm-screen').waitFor({ state: 'attached', timeout: 60_000 });
  // capturePtyInput() answers true once the surface has a terminal to subscribe to.
  await page.waitForFunction(
    () => window.__tesseraTerminalScrollRepro?.capturePtyInput() === true,
    { timeout: 30_000 },
  );
}

// The alternate buffer, with no mouse reporting: what a pager or an editor leaves behind.
async function enterAltScreen(page) {
  await writeOutput(page, '\x1b[?1049h');
  await page.waitForFunction(
    () => window.__tesseraTerminalScrollRepro?.bufferType() === 'alternate',
    { timeout: 15_000 },
  );
}

async function writeOutput(page, data) {
  const written = await page.evaluate(
    (value) => window.__tesseraTerminalScrollRepro?.writeOutput(value) ?? false,
    data,
  );
  assert.equal(written, true, 'the repro page should accept terminal output');
}

async function repro(page, method) {
  return page.evaluate((name) => window.__tesseraTerminalScrollRepro?.[name]() ?? null, method);
}

async function ptyInputDuringTouchDrag(page, options = {}) {
  await page.evaluate(() => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput());

  await touchDrag(page, options);
  // xterm keeps dispatching gesture changes after the finger lifts, as inertia.
  await page.waitForTimeout(1_000);

  const captured = await page.evaluate(
    () => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput() ?? [],
  );
  return captured.join('');
}

async function touchDrag(page, { deltaY = -240, steps = 12 } = {}) {
  const box = await page.locator('.xterm-screen').boundingBox();
  assert.ok(box, 'the terminal screen element should be measurable');

  const startX = Math.round(box.x + box.width / 2);
  const startY = Math.round(box.y + box.height * (deltaY < 0 ? 0.75 : 0.25));

  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y: startY, id: 1 }],
    });
    for (let step = 1; step <= steps; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX, y: Math.round(startY + (deltaY * step) / steps), id: 1 }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => undefined);
  }
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
