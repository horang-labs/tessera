// Ticket #248 — floating overlays are clamped to the viewport.
//
// One defect with two faces: the toast and the notification centre are both `fixed`, both
// of a fixed width, and neither was clamped. Everything asserted here is a measured box,
// which is why the server runs from the repository itself rather than from a copied app
// root — Tailwind only generates its utility layer for the source tree it is pointed at,
// and an unstyled overlay measures as its content (#252).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MINIMUM_TOUCH_TARGET_PX = 44;
const VIEWPORT_TOLERANCE_PX = 1;
// The app's own presets, from `FONT_SCALE_OPTIONS`. The largest is what turns the toast's
// `rem` offsets into a real overflow at 360px.
const FONT_SCALE_RANGE = [1, 1.375];

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-overlay-clamp-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

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

  browser = await launchPhoneBrowser();
  await testNotificationCentreStaysWithinThePhoneViewport(browser, appOrigin);
  await testToastStaysWithinThePhoneViewport(browser, appOrigin);
  await testToastCloseControlIsTouchSized(browser, appOrigin);
  await testDesktopOverlayPositionsAreUnchanged(browser, appOrigin);
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

// "Opening the notification centre, part of it is off-screen or unreachable." The bell sits
// in the left strip, so the centre opens rightwards from roughly x=44 at a 320px width.
async function testNotificationCentreStaysWithinThePhoneViewport(browserInstance, origin) {
  const { context, page, pushNotification } = await createPhonePage(browserInstance);

  try {
    await openChat(page, origin);
    await pushNotification();
    await openNotificationCentre(page);

    const box = await page.getByTestId('notification-center').boundingBox();
    assertWithinViewport(box, PHONE_VIEWPORT, 'the notification centre');
  } finally {
    await context.close();
  }
}

// Measured at both ends of the app's own font-scale range, because at the default scale
// the toast happens to have 28px of slack — `3.75rem + 17rem` is 332px of a 360px screen —
// and an assertion taken there passes with no clamp at all. Both offsets are declared in
// `rem`, so the largest preset takes them to 456px and the missing clamp becomes visible.
// This is the same trap #251 hit: a default state with exactly zero slack proves nothing.
async function testToastStaysWithinThePhoneViewport(browserInstance, origin) {
  for (const fontScale of FONT_SCALE_RANGE) {
    const { context, page, pushNotification } = await createPhonePage(browserInstance);

    try {
      await setFontScale(context, origin, fontScale);
      await openChat(page, origin);
      await pushNotification();
      await page.getByTestId('toast-notification').first().waitFor();
      await settleToastAnimation(page);

      const box = await page.getByTestId('toast-notification').first().boundingBox();
      assertWithinViewport(box, PHONE_VIEWPORT, `the toast at font scale ${fontScale}`);

      const containerBox = await page.getByTestId('toast-container').boundingBox();
      assertWithinViewport(
        containerBox,
        PHONE_VIEWPORT,
        `the toast container at font scale ${fontScale}`,
      );
    } finally {
      await context.close();
    }
  }

  await resetFontScale(browserInstance, origin);
}

// The thing blocking the reporter's typing was also the thing they could not dismiss, so
// reachability of the close control is part of this defect, not cosmetics.
async function testToastCloseControlIsTouchSized(browserInstance, origin) {
  const { context, page, pushNotification } = await createPhonePage(browserInstance);

  try {
    await openChat(page, origin);
    await pushNotification();
    await page.getByTestId('toast-notification').first().waitFor();
    await settleToastAnimation(page);

    const dismiss = page.getByTestId('toast-dismiss').first();
    const box = await dismiss.boundingBox();
    assert.ok(box, 'the toast close control should be measurable');
    assert.ok(
      box.width >= MINIMUM_TOUCH_TARGET_PX && box.height >= MINIMUM_TOUCH_TARGET_PX,
      `the toast close control must be at least ${MINIMUM_TOUCH_TARGET_PX}px square at Phone viewport`
        + ` (measured ${Math.round(box.width)}x${Math.round(box.height)}px)`,
    );
    assertWithinViewport(box, PHONE_VIEWPORT, 'the toast close control');

    // Reachable means it dismisses when tapped, not merely that it is large.
    await dismiss.tap();
    await page.getByTestId('toast-notification').first().waitFor({ state: 'detached' });
  } finally {
    await context.close();
  }
}

// The overriding constraint for this wave: the desktop layout must not regress. Where there
// is room, the clamp has to be inert — the same coordinates as before it existed.
async function testDesktopOverlayPositionsAreUnchanged(browserInstance, origin) {
  const { context, page, pushNotification } = await createDesktopPage(browserInstance);

  try {
    await openChat(page, origin);
    await pushNotification();
    await page.getByTestId('toast-notification').first().waitFor();
    await settleToastAnimation(page);

    // The container's own declaration: `bottom: 1.25rem; left: 3.75rem`.
    const containerBox = await page.getByTestId('toast-container').boundingBox();
    assert.ok(containerBox, 'the toast container should be measurable on a desktop viewport');
    assert.equal(
      Math.round(containerBox.x),
      60,
      'the toast must keep its desktop left offset of 3.75rem',
    );
    assert.equal(
      Math.round(containerBox.y + containerBox.height),
      DESKTOP_VIEWPORT.height - 20,
      'the toast must keep its desktop bottom offset of 1.25rem',
    );

    const dismissBox = await page.getByTestId('toast-dismiss').first().boundingBox();
    assert.ok(dismissBox, 'the desktop toast close control should be measurable');
    assert.ok(
      dismissBox.width < MINIMUM_TOUCH_TARGET_PX,
      'the phone touch target must not reach a desktop viewport'
        + ` (measured ${Math.round(dismissBox.width)}px)`,
    );

    await openNotificationCentre(page);
    const bellBox = await page.getByTestId('notification-bell').boundingBox();
    const centreBox = await page.getByTestId('notification-center').boundingBox();
    assert.ok(bellBox && centreBox, 'the bell and the notification centre should be measurable');
    // `direction="right"` opens the centre at `anchorRect.right + 6`, bottom-aligned to the bell.
    assert.equal(
      Math.round(centreBox.x),
      Math.round(bellBox.x + bellBox.width) + 6,
      'the notification centre must keep its desktop offset from the bell',
    );
    assert.equal(
      Math.round(centreBox.y + centreBox.height),
      Math.round(bellBox.y + bellBox.height),
      'the notification centre must stay bottom-aligned to the bell on a desktop viewport',
    );
    assert.equal(Math.round(centreBox.width), 320, 'the desktop notification centre keeps its width');
  } finally {
    await context.close();
  }
}

function assertWithinViewport(box, viewport, label) {
  assert.ok(box, `${label} should be measurable`);
  assert.ok(
    box.x >= -VIEWPORT_TOLERANCE_PX
      && box.y >= -VIEWPORT_TOLERANCE_PX
      && box.x + box.width <= viewport.width + VIEWPORT_TOLERANCE_PX
      && box.y + box.height <= viewport.height + VIEWPORT_TOLERANCE_PX,
    `${label} must lie entirely within the ${viewport.width}x${viewport.height} viewport`
      + ` (left ${Math.round(box.x)}px, right ${Math.round(box.x + box.width)}px,`
      + ` top ${Math.round(box.y)}px, bottom ${Math.round(box.y + box.height)}px)`,
  );
}

async function setFontScale(context, origin, fontScale) {
  const response = await context.request.put(`${origin}/api/settings`, {
    headers: { origin },
    data: { fontSize: fontScale },
  });
  assert.ok(response.ok(), `setting the font scale should succeed (${response.status()})`);
}

async function resetFontScale(browserInstance, origin) {
  const context = await browserInstance.newContext({
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  try {
    await setFontScale(context, origin, 1);
  } finally {
    await context.close();
  }
}

async function openNotificationCentre(page) {
  await page.getByTestId('notification-bell').click();
  await page.getByTestId('notification-center').waitFor();
}

// Both overlays animate in. Measuring mid-flight reads a transform, not a resting position.
async function settleToastAnimation(page) {
  await page.waitForTimeout(400);
}

async function createPhonePage(browserInstance) {
  const context = await createPhoneContext(browserInstance, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  return preparePage(context);
}

async function createDesktopPage(browserInstance) {
  const context = await browserInstance.newContext({
    viewport: DESKTOP_VIEWPORT,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  return preparePage(context);
}

// A toast is raised by a server notification, so the socket is intercepted and the message
// pushed from the test. The socket is not forwarded to the real server: the app's own
// connection is token-authenticated and the server closes it here, which would take the
// injected message down with it. Nothing under test reads anything else off the socket.
async function preparePage(context) {
  const page = await context.newPage();
  let socket = null;

  await page.routeWebSocket(/\/ws(\?|$)/, (route) => {
    socket = route;
  });

  const pushNotification = async () => {
    for (let attempt = 0; !socket && attempt < 50; attempt += 1) {
      await page.waitForTimeout(100);
    }
    assert.ok(socket, 'the app should have opened its WebSocket by now');
    socket.send(JSON.stringify({
      type: 'notification',
      sessionId: 'overlay-clamp-session',
      event: 'input_required',
      message: 'Waiting for input',
      // Long enough that a surface which grew with its content would be caught doing it.
      preview: 'A session is waiting for an answer before it can continue with the next step',
      actions: [
        { label: 'Approve', value: 1, primary: true },
        { label: 'Reject', value: 2 },
      ],
    }));
  };

  return { context, page, pushNotification };
}

async function openChat(page, origin) {
  // 'load' rather than 'domcontentloaded': every box here is a styled box, and an unstyled
  // overlay measures as its content instead of as its declared width.
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
}

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
  const deadline = Date.now() + 60_000;
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for isolated Tessera server at ${url}`);
}
