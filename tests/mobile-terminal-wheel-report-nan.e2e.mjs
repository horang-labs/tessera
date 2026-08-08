// Ticket #257 — a touch scroll over a wheel-reporting TUI must not send it a mouse
// report with no coordinates.
//
// #246 removed the arrow-key branch of `_handleTouchChange`. This is the branch it
// deliberately kept: a TUI that requested wheel reporting gets `_handleTouchScrollAsWheel`,
// which asks `MouseCoordsService.getMouseReportCoords()` where the gesture is and encodes
// that as an SGR report.
//
// The defect is in the gesture, not in the touch event. `Gesture._handleTouchMove()` copies
// `clientX`/`clientY` onto the CHANGE event it dispatches; `Gesture._inertia()`, which keeps
// dispatching CHANGE events after the finger lifts, sets only `translationX`/`translationY`.
// `getCoordsRelativeToElement` then computes `undefined - rect.left - padding` — NaN — and
// the `{col: NaN, row: NaN, ...}` object it returns is truthy, so xterm's own `if (coords)`
// guard passes it straight through as `ESC [ < 65 ; NaN ; NaN M`.
//
// The seam is the byte stream leaving the terminal: `capturePtyInput()` subscribes to
// xterm's `onData`, which is what the surface forwards to the PTY. The acceptance criteria
// name that stream specifically — "asserted on the actual terminal_input payloads, not on
// the rendered screen".
//
// The gesture is dispatched as real touch events through CDP, because xterm's gesture layer
// listens on the document for touchstart/touchmove/touchend and synthesizes its own events
// from them. The inertia phase this ticket is about only starts on a real `touchend`.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';

const run = promisify(execFile);
const PATCH_SCRIPT = 'scripts/patch-xterm-mouse-report-coords.mjs';
const BUNDLE_FILES = [
  'node_modules/@xterm/xterm/lib/xterm.mjs',
  'node_modules/@xterm/xterm/lib/xterm.js',
];

// SGR-encoded wheel reports: buttons 64 (up) and 65 (down), with numeric coordinates.
const WHEEL_REPORT_SEQUENCE = /\x1b\[<6[45];\d+;\d+M/;
// What a coordinate-less report looks like on the wire. `Math.floor(NaN)` stringifies to
// "NaN", so the report the TUI cannot parse carries the word literally.
const COORDINATE_LESS_REPORT = /NaN/;

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-wheel-report-nan-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

const BROWSER_USER_ID = 'e2e-wheel-report-nan-user';

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

  browser = await launchPhoneBrowser();
  await testTouchSwipeSendsNoCoordinateLessReport(browser, appOrigin);
  await testDesktopMouseWheelStillReportsWithCoordinates(browser, appOrigin);
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

console.log('mobile terminal wheel-report NaN e2e passed');

// ----------------------------------------------------------------- patch ---

// Idempotence, the convention patch-xterm-touch-scroll.mjs and patch-xterm-webgl-atlas.mjs
// established. The bundles this repository installs are already patched, so a fixture cut
// from them is the state a second run meets, and a second run must change nothing.
async function testPatchLeavesAnAlreadyPatchedBundleAlone() {
  const fixture = await createBundleFixture((source) => source);

  try {
    for (const relative of BUNDLE_FILES) {
      assert.match(
        fixture.before.get(relative),
        /getMouseReportCoords/,
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

// An upgrade that renames or fixes the code upstream must leave the bundle untouched rather
// than half-rewritten. Renaming the method is what such an upgrade looks like from outside.
async function testPatchLeavesABundleWithoutTheTargetAlone() {
  const fixture = await createBundleFixture(
    (source) => source.replaceAll('getMouseReportCoords', 'getMouseReportPosition'),
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
  const dir = await fs.mkdtemp(path.join(tempRoot, 'tessera-wheel-report-nan-bundle-'));
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

// The reported symptom: the TUI's prompt fills with `aN;NaNMaN;NaNM…` after a swipe,
// because the tail of an unparseable `ESC [ < 65 ; NaN ; NaN M` is printed as literal text.
async function testTouchSwipeSendsNoCoordinateLessReport(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openRepro(page, origin);
    await enterWheelReportingTui(page);

    const captured = await ptyInputDuringTouchDrag(page);

    assert.doesNotMatch(
      captured,
      COORDINATE_LESS_REPORT,
      'a touch swipe over a wheel-reporting TUI must not send a report with no coordinates,'
        + ` got ${JSON.stringify(captured)}`,
    );
    // The fix removes only the poisoned reports. A TUI that scrolls on wheel reports must
    // keep scrolling on touch, so the well-formed ones have to survive the same swipe.
    assert.match(
      captured,
      WHEEL_REPORT_SEQUENCE,
      'the swipe must still deliver well-formed wheel reports,'
        + ` got ${JSON.stringify(captured)}`,
    );
  } finally {
    await context.close();
  }
}

// The desktop case the fix must not cost: a real mouse wheel over the same TUI still
// reports, still carries coordinates, and is still multiplied into several reports by
// `attachTerminalMouseWheelMultiplier`.
async function testDesktopMouseWheelStillReportsWithCoordinates(browserInstance, origin) {
  const context = await browserInstance.newContext({
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([{
    name: 'jwt',
    value: await mintBrowserToken(),
    domain: '127.0.0.1',
    path: '/',
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();

  try {
    await openRepro(page, origin);
    await enterWheelReportingTui(page);
    await page.evaluate(() => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput());

    const box = await page.locator('.xterm-screen').boundingBox();
    assert.ok(box, 'the terminal screen element should be measurable');
    await page.mouse.move(
      Math.round(box.x + box.width / 2),
      Math.round(box.y + box.height / 2),
    );
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(500);

    const captured = (await page.evaluate(
      () => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput() ?? [],
    )).join('');

    assert.match(
      captured,
      WHEEL_REPORT_SEQUENCE,
      `a desktop mouse wheel must still report, got ${JSON.stringify(captured)}`,
    );
    assert.doesNotMatch(
      captured,
      COORDINATE_LESS_REPORT,
      `a desktop mouse wheel must carry coordinates, got ${JSON.stringify(captured)}`,
    );
    // The multiplier is what turns one wheel notch into several reports. Asserting more
    // than one is how this test would notice the fix silently disabling it.
    assert.ok(
      captured.match(/\x1b\[<6[45];\d+;\d+M/g)?.length > 1,
      'the wheel multiplier must still emit several reports per notch,'
        + ` got ${JSON.stringify(captured)}`,
    );
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------ page ---

// The modes a mouse-reporting TUI asserts: tracking plus SGR encoding. This is the state
// Claude Code puts the terminal in, and the one that routes a touch gesture through
// `_handleTouchScrollAsWheel` instead of a viewport scroll.
async function enterWheelReportingTui(page) {
  const written = await page.evaluate(
    (value) => window.__tesseraTerminalScrollRepro?.writeOutput(value) ?? false,
    '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  );
  assert.equal(written, true, 'the repro page should accept terminal output');
  await page.waitForFunction(
    () => window.__tesseraTerminalScrollRepro?.mouseReporting() === true,
    { timeout: 15_000 },
  );
}

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

async function ptyInputDuringTouchDrag(page, options = {}) {
  await page.evaluate(() => window.__tesseraTerminalScrollRepro?.takeCapturedPtyInput());

  await touchDrag(page, options);
  // The inertia phase is the one under test, and it outlives the finger: xterm keeps
  // dispatching gesture changes on animation frames until friction stops them.
  await page.waitForTimeout(1_500);

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
      // A finger moves over time. Without a gap the gesture's rolling timestamps can share
      // a millisecond, and the velocity it divides by that interval stops being a number
      // a swipe could actually produce.
      await page.waitForTimeout(8);
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
