// Ticket #256 — terminal glyphs must not be scaled by devicePixelRatio.
//
// The seam is the pair of canvases xterm's WebGL renderer puts inside one `.xterm-screen`:
// the addon's own WebGL canvas, which draws the glyphs, and the link layer beside it. Both
// are sized from the same `IRenderDimensions`, so a difference between them is the defect
// itself rather than a symptom of it. Every assertion here reads canvas dimensions, which
// are computed in JS rather than rasterised, so they survive the software WebGL backend.
//
// The run is headful (#263), but note what that does and does not buy: the scale still
// arrives through `deviceScaleFactor`, which is device-metrics emulation in any window.
// A real display supplies the scale instead, and there `devicePixelContentBoxSize` agrees
// with `devicePixelRatio` — which is why #256 closed as a harness artifact. What this file
// pins is the patched observer's behaviour under the contradiction, not a phone defect.
//
// The defect is in the vendored @xterm/addon-webgl bundle, not in Tessera. The addon sizes
// the WebGL canvas twice: `handleResize` sets it to `dimensions.device.canvas`, which is
// CSS size x devicePixelRatio, and then a ResizeObserver watching
// `device-pixel-content-box` overwrites it with whatever the browser reports. Chromium's
// device-metrics emulation raises `window.devicePixelRatio` without raising
// `devicePixelContentBoxSize`, so the observer reports the 1x box and shrinks the backing
// store back to CSS size while the glyphs are still rasterised at DPR-scaled metrics.
// scripts/patch-xterm-webgl-device-pixel.mjs makes the observer ignore a report that
// contradicts devicePixelRatio, and only such a report.
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
const PATCH_SCRIPT = 'scripts/patch-xterm-webgl-device-pixel.mjs';
const BUNDLE_FILES = [
  'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
  'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
];

// Both the reported device pixel box and the CSS box are integers rounded from the same
// fractional layout, so the two can legitimately disagree by a pixel. Three times too
// large is not a rounding difference.
const ROUNDING_SLACK_PX = 1;

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-dpr-scale-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

const BROWSER_USER_ID = 'e2e-dpr-scale-user';

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
  await testBackingStoreFollowsDevicePixelRatio(browser, appOrigin, 1);
  await testBackingStoreFollowsDevicePixelRatio(browser, appOrigin, 2);
  await testBackingStoreFollowsDevicePixelRatio(browser, appOrigin, 3);
  await testGlyphsKeepTheirCssSizeAcrossDevicePixelRatios(browser, appOrigin);
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

console.log('mobile terminal DPR scale e2e passed');

// --------------------------------------------------------------- canvases ---

// The acceptance criterion, stated as the ticket states it: the WebGL canvas's backing
// store equals its CSS box multiplied by devicePixelRatio. The link layer of the same
// terminal is measured alongside it as the control the ticket used to localise the defect.
async function testBackingStoreFollowsDevicePixelRatio(browserInstance, origin, dpr) {
  const { context, page } = await createPhonePage(browserInstance, dpr);

  try {
    await openRepro(page, origin);
    const measured = await measureCanvases(page);

    assert.equal(
      measured.devicePixelRatio,
      dpr,
      'the page must actually report the device pixel ratio under test',
    );
    assert.ok(
      measured.webgl,
      'the WebGL renderer must be attached, or this measures the DOM fallback instead',
    );

    for (const layer of ['webgl', 'link']) {
      const canvas = measured[layer];
      assert.ok(canvas, `the ${layer} canvas must be present`);
      assert.ok(
        canvas.cssWidth > 0 && canvas.cssHeight > 0,
        `the ${layer} canvas must have a laid-out CSS box, got ${JSON.stringify(canvas)}`,
      );
      assertScaledBy(canvas, dpr, layer);
    }

    // The two layers are sized from one IRenderDimensions, so they cannot legitimately
    // disagree. This is the exact comparison the ticket's measurement table makes, and it
    // is also what the user sees: the link layer's backing store is the coordinate space
    // the glyphs are rasterised into, so dividing it by the WebGL backing store gives the
    // magnification on screen. Three at DPR 3 is the reported symptom — ten characters
    // across a 360px phone, every line running off the right edge.
    const magnification = measured.link.width / measured.webgl.width;
    assert.ok(
      Math.abs(magnification - 1) < 0.05,
      'glyphs must be rasterised into a backing store of their own size, so a glyph keeps'
        + ` its CSS size at every device pixel ratio; got ${magnification.toFixed(2)}x`
        + ` magnification at DPR ${dpr} from ${JSON.stringify(measured)}`,
    );
  } finally {
    await context.close();
  }
}

// The other half of the acceptance criterion: glyphs render at the same CSS size at DPR 3
// as at DPR 1, so a full line of TUI output is legible instead of running off the right
// edge. The measurement is taken from the painted pixels rather than from the dimensions
// above, and it is the distance between two rows of text — a spacing, not a shape, so it
// survives whatever a software rasteriser does to the edges of a glyph. What is compared
// across ratios is the CSS distance, which is a device-independent number.
async function testGlyphsKeepTheirCssSizeAcrossDevicePixelRatios(browserInstance, origin) {
  const spacings = new Map();

  for (const dpr of [1, 3]) {
    const { context, page } = await createPhonePage(browserInstance, dpr);
    try {
      await openRepro(page, origin);
      // Two marks one blank row apart. Any magnification of the glyph grid moves them
      // apart by the same factor; keeping them adjacent means even a magnified pair still
      // lands inside the canvas, so the failure reports the spacing rather than a row that
      // has already been pushed off the screen.
      await writeOutput(page, 'M\r\n\r\nM');
      await page.waitForTimeout(1_000);
      spacings.set(dpr, await measureRowSpacingInCssPixels(page, dpr));
    } finally {
      await context.close();
    }
  }

  const baseline = spacings.get(1);
  const scaled = spacings.get(3);
  assert.ok(
    baseline > 0 && scaled > 0,
    `both runs must find two rows of painted text, got ${baseline} and ${scaled}`,
  );
  // A row of 13px text sits well inside this; three times that does not.
  assert.ok(
    Math.abs(scaled - baseline) <= 2,
    'text rows must sit the same CSS distance apart at DPR 3 as at DPR 1, or the glyphs'
      + ` are magnified: ${baseline.toFixed(1)}px at DPR 1 and ${scaled.toFixed(1)}px at DPR 3`,
  );
}

// Screenshots the WebGL canvas and returns the CSS distance between the first two bands of
// painted rows. The PNG is decoded by handing it back to the page: the browser is already
// a decoder, and pulling in an image library for one measurement is not worth a dependency.
async function measureRowSpacingInCssPixels(page, dpr) {
  // The screen element is sized to the canvas by the same handleResize, and both canvases
  // inside it share that CSS box, so clipping to it captures the glyphs and nothing else.
  const box = await page.locator('.xterm-screen').boundingBox();
  assert.ok(box, 'the terminal screen element should be measurable');

  const shot = (await page.screenshot({ clip: box })).toString('base64');
  const bands = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = image.width;
    surface.height = image.height;
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);

    // The top-left pixel is background: the terminal's first cell starts a glyph's width
    // in, and a blank row would look the same anyway.
    const background = [data[0], data[1], data[2]];
    const isInk = (offset) => (
      Math.abs(data[offset] - background[0])
      + Math.abs(data[offset + 1] - background[1])
      + Math.abs(data[offset + 2] - background[2])
    ) > 60;

    const inkedRows = [];
    for (let y = 0; y < image.height; y += 1) {
      let inked = false;
      for (let x = 0; x < image.width && !inked; x += 1) {
        inked = isInk((y * image.width + x) * 4);
      }
      inkedRows.push(inked);
    }

    const found = [];
    let start = -1;
    for (let y = 0; y <= inkedRows.length; y += 1) {
      if (inkedRows[y]) {
        if (start === -1) start = y;
      } else if (start !== -1) {
        found.push((start + y - 1) / 2);
        start = -1;
      }
    }
    return { centres: found };
  }, shot);

  assert.ok(
    bands.centres.length >= 2,
    `expected two bands of painted text in the canvas at DPR ${dpr},`
      + ` found ${bands.centres.length} — a magnified glyph grid can push the second row`
      + ' out of the canvas entirely, which is the clipping this ticket is about',
  );
  // The screenshot is in device pixels; the assertion compares CSS distances.
  return (bands.centres[1] - bands.centres[0]) / dpr;
}

async function writeOutput(page, data) {
  const written = await page.evaluate(
    (value) => window.__tesseraTerminalScrollRepro?.writeOutput(value) ?? false,
    data,
  );
  assert.equal(written, true, 'the repro page should accept terminal output');
}

function assertScaledBy(canvas, dpr, layer) {
  const expectedWidth = canvas.cssWidth * dpr;
  const expectedHeight = canvas.cssHeight * dpr;
  assert.ok(
    Math.abs(canvas.width - expectedWidth) <= ROUNDING_SLACK_PX,
    `the ${layer} canvas backing store width must be its CSS width x ${dpr}`
      + ` (expected ~${expectedWidth}, got ${canvas.width})`,
  );
  assert.ok(
    Math.abs(canvas.height - expectedHeight) <= ROUNDING_SLACK_PX,
    `the ${layer} canvas backing store height must be its CSS height x ${dpr}`
      + ` (expected ~${expectedHeight}, got ${canvas.height})`,
  );
}

// The WebGL canvas is the one the addon appends to `.xterm-screen`; the render layers it
// creates carry an `xterm-<name>-layer` class. Reading both from the DOM keeps the
// measurement at the same seam the ticket measured.
async function measureCanvases(page) {
  return page.evaluate(() => {
    const describe = (canvas) => (canvas ? {
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width,
      cssHeight: canvas.getBoundingClientRect().height,
    } : null);
    const screen = document.querySelector('.xterm-screen');
    const canvases = screen ? Array.from(screen.querySelectorAll('canvas')) : [];
    const link = canvases.find((canvas) => canvas.classList.contains('xterm-link-layer'));
    // The addon's own canvas is the only one in the screen element with no class: every
    // render layer it creates is tagged `xterm-<name>-layer`.
    const webgl = canvases.find((canvas) => canvas.classList.length === 0);
    return {
      devicePixelRatio: window.devicePixelRatio,
      webgl: describe(webgl),
      link: describe(link),
    };
  });
}

// ------------------------------------------------------------------ patch ---

// Idempotence. The bundles this repository installs are already patched, so a fixture cut
// from them is the state a second run meets, and a second run must change nothing.
async function testPatchLeavesAnAlreadyPatchedBundleAlone() {
  const fixture = await createBundleFixture((source) => source);

  try {
    for (const relative of BUNDLE_FILES) {
      assert.match(
        fixture.before.get(relative),
        /devicePixelContentBoxSize/,
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

// The convention the precedent scripts establish: an upgrade that renames or fixes the
// code upstream must leave the bundle untouched rather than half-rewritten. Renaming the
// observed box is what such an upgrade looks like from the outside.
async function testPatchLeavesABundleWithoutTheTargetAlone() {
  const fixture = await createBundleFixture(
    (source) => source.replaceAll('devicePixelContentBoxSize', 'devicePixelBoxSize'),
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
  const dir = await fs.mkdtemp(path.join(tempRoot, 'tessera-dpr-scale-bundle-'));
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

async function mintBrowserToken() {
  const privateKey = await fs.readFile(path.join(dataDir, 'auth', 'private.pem'), 'utf8');
  return jwt.sign(
    { sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
    privateKey,
    { algorithm: 'RS256', expiresIn: 3600 },
  );
}

async function createPhonePage(browserInstance, deviceScaleFactor) {
  const context = await createPhoneContext(browserInstance, {
    deviceScaleFactor,
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
  // The WebGL canvas is appended after the terminal opens, and sized once the renderer has
  // measured the font. Wait for a laid-out canvas rather than a mounted element.
  await page.waitForFunction(
    () => {
      const screen = document.querySelector('.xterm-screen');
      const canvas = screen
        ? Array.from(screen.querySelectorAll('canvas')).find((c) => c.classList.length === 0)
        : null;
      return Boolean(canvas && canvas.width > 0 && canvas.getBoundingClientRect().width > 0);
    },
    { timeout: 30_000 },
  );
  // The observer that overwrites the backing store fires after layout, so a measurement
  // taken in the same frame as the first paint can miss it.
  await page.waitForTimeout(1_000);
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
