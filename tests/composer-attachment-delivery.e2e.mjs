/**
 * End-to-end coverage for delivering a composer attachment to the CLI (#254).
 *
 * QA read the failure at the socket: a `send_message` frame carrying `content`,
 * `messageId` and `displayContent` and no attachment field of any kind, while a
 * blob preview sat in the composer. It failed identically at 1280px, so this is
 * not a phone branch — the phone context here is a second viewport over the same
 * path, not the subject of the test.
 *
 * The seam is that outgoing frame: the last point the client controls. What
 * happens before it (whether the picker opens, whether a preview renders) QA
 * already settled, and what happens after it is the server's, which QA showed
 * never received anything.
 *
 *   1. Phone viewport (360x776, touch): an image whose marker the text lost is
 *      still delivered.
 *   2. Phone viewport: an attachment does not follow the user into another
 *      session, in the composer or in the frame.
 *   3. Phone viewport: the file input tells the picker which images it wants
 *      without giving up arbitrary files.
 *   4. Desktop width (1280x900, no touch): attaching and sending is unchanged.
 *
 * The server runs from the repository itself, not from a copy: the composer has
 * to be laid out to be typed into, and Tailwind only generates its utility layer
 * for the source tree it is pointed at (#252).
 *
 * What this file cannot cover: whether Android Chrome's clipboard carries an
 * image at all, and what its picker offers for a given `accept`. Both are
 * device-only; the `accept` assertion records what the element declares, not
 * what a phone does with it.
 *
 * Phases can be selected with TESSERA_E2E_PHASES=1 while iterating.
 */

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

/** A pointer-driven window, which is what must not regress. */
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/** A 1x1 PNG. The bytes matter only in that the client must forward exactly these. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const BROWSER_USER_ID = 'e2e-browser-user';

// Headless by default through the wave's shared launcher. Visual QA can opt into
// a visible browser with `TESSERA_E2E_HEADED=1`.
const selectedPhases = (process.env.TESSERA_E2E_PHASES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-attachment-data-'));
const fixtureDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-attachment-fixture-'));
const projectDir = path.join(fixtureDir, `attachment-e2e-${path.basename(fixtureDir).slice(-6)}`);
const imagePath = path.join(fixtureDir, 'attachment.png');

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;

const serverOutput = [];
let server = null;
let browser = null;
let appSecret = null;
const results = [];

function shouldRun(phase) {
  return selectedPhases.length === 0 || selectedPhases.includes(String(phase));
}

function logs() {
  return serverOutput.join('');
}

try {
  await prepareFixture();
  await writeBrowserUser();
  await startServer();
  await registerProject();

  browser = await launchPhoneBrowser();

  if (shouldRun(1)) results.push(await testAnImageWhoseMarkerTheTextLostIsStillDelivered());
  if (shouldRun(2)) results.push(await testAttachmentsDoNotFollowTheUserIntoAnotherSession());
  if (shouldRun(3)) results.push(await testThePickerIsToldWhichImagesAreSupported());
  if (shouldRun(4)) results.push(await testDesktopAttachAndSendIsUnchanged());

  console.log(JSON.stringify({ origin, results }, null, 2));
} catch (error) {
  process.stderr.write(`\n--- isolated server output ---\n${logs()}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fixtureDir, { recursive: true, force: true });
}

// --------------------------------------------------------------------- ui ---

/**
 * The composer's marker (`[📷 1]`) is ordinary editable text. Rewriting the
 * message takes it with it while the image stays attached and its preview stays
 * on screen — and the image still has to be sent, because as far as the user can
 * tell it is attached.
 */
async function testAnImageWhoseMarkerTheTextLostIsStillDelivered() {
  const sessionId = await createSession('marker lost');
  const { context, page, frames } = await openPhonePage();

  try {
    const composer = await openComposer(page, sessionId);
    await attachImage(page, sessionId);
    await assertPreviewIsOnScreen(page, sessionId);

    await composer.fill('here is the screenshot');
    assert.equal(
      await composer.inputValue(),
      'here is the screenshot',
      'the rewritten message should no longer carry the attachment marker',
    );
    await assertPreviewIsOnScreen(page, sessionId);

    frames.length = 0;
    await composer.press('Enter');
    const frame = await waitForSendFrame(page, frames);

    assert.deepEqual(
      imageDataIn(frame.content),
      [PNG_BASE64],
      `the sent frame must carry the attached image (content was ${JSON.stringify(frame.content)})`,
    );
    assert.deepEqual(
      imageDataIn(frame.displayContent),
      [PNG_BASE64],
      'the sent bubble must show the image it just sent',
    );
    assert.equal(
      textIn(frame.content),
      'here is the screenshot',
      'the typed message must survive alongside the image',
    );

    return { phase: 1, delivered: true };
  } finally {
    await context.close();
  }
}

/**
 * An attachment belongs to the composer that collected it, and each open session
 * has its own: a second session must neither show it nor send it.
 *
 * This one was never red, and is here for what the rest of the ticket changes
 * around it — the send builders now deliver attachments the text no longer
 * names, so "delivers whatever is attached" must not become "delivers someone
 * else's". A composer that is handed a different session drops what it was
 * holding (`message-input.tsx`), which is the other half of the same rule.
 */
async function testAttachmentsDoNotFollowTheUserIntoAnotherSession() {
  const firstSessionId = await createSession('attaches an image');
  const secondSessionId = await createSession('receives no image');
  const { context, page, frames } = await openDesktopPage();

  try {
    await openComposer(page, firstSessionId);
    await attachImage(page, firstSessionId);
    await assertPreviewIsOnScreen(page, firstSessionId);

    const secondComposer = await openComposer(page, secondSessionId);
    await page.waitForTimeout(500);
    assert.equal(
      await previewCountFor(page, secondSessionId),
      0,
      "the other session's attachment must not appear in this composer",
    );

    frames.length = 0;
    await secondComposer.click();
    await secondComposer.pressSequentially('a message of its own');
    await secondComposer.press('Enter');
    const frame = await waitForSendFrame(page, frames);

    assert.equal(frame.sessionId, secondSessionId);
    assert.deepEqual(
      imageDataIn(frame.content),
      [],
      `a message in another session must carry no image (content was ${JSON.stringify(frame.content)})`,
    );

    return { phase: 2, leaked: false };
  } finally {
    await context.close();
  }
}

/**
 * A phone picker surfaces the gallery and camera when the input says it wants
 * images. Saying so must not cost the ability to attach anything else: uploaded
 * files are the other half of this control and #254 does not narrow it.
 */
async function testThePickerIsToldWhichImagesAreSupported() {
  const sessionId = await createSession('picker hints');
  const { context, page } = await openPhonePage();

  try {
    await openComposer(page, sessionId);
    const fileInput = fileInputFor(page, sessionId);
    const accept = await fileInput.getAttribute('accept');

    assert.ok(accept, 'the file input must declare what it accepts');
    const declared = accept.split(',').map((entry) => entry.trim());
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      assert.ok(
        declared.includes(mediaType),
        `the picker should be told ${mediaType} is supported (accept was "${accept}")`,
      );
    }
    assert.ok(
      declared.includes('*/*'),
      `attaching a non-image file must stay possible (accept was "${accept}")`,
    );
    assert.equal(
      await fileInput.getAttribute('capture'),
      null,
      'forcing the camera would take the gallery away',
    );

    return { phase: 3, accept };
  } finally {
    await context.close();
  }
}

/** The overriding constraint for this wave: the desktop must not regress. */
async function testDesktopAttachAndSendIsUnchanged() {
  const sessionId = await createSession('desktop attach');
  const { context, page, frames } = await openDesktopPage();

  try {
    const composer = await openComposer(page, sessionId);
    await composer.click();
    await composer.pressSequentially('look at this');
    await attachImage(page, sessionId);
    await assertPreviewIsOnScreen(page, sessionId);

    assert.match(
      await composer.inputValue(),
      /\[📷 \d+\]/,
      'the desktop composer should still mark where the image sits',
    );

    frames.length = 0;
    await composer.press('Enter');
    const frame = await waitForSendFrame(page, frames);

    assert.deepEqual(
      imageDataIn(frame.content),
      [PNG_BASE64],
      `the desktop send must carry the image (content was ${JSON.stringify(frame.content)})`,
    );
    assert.equal(textIn(frame.content), 'look at this');
    assert.equal(await composer.inputValue(), '', 'a completed send clears the composer');
    assert.equal(
      await previewCountFor(page, sessionId),
      0,
      'a completed send clears the attachment strip',
    );

    return { phase: 4, delivered: true };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- helpers ---

function imageDataIn(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'image')
    .map((block) => block.source?.data);
}

function textIn(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
}

/**
 * `toBeVisible` ignores opacity, and the preview is the user's only evidence
 * that the image is attached — so it is checked the way the user sees it.
 */
async function assertPreviewIsOnScreen(page, sessionId) {
  const preview = page.locator(`textarea[data-session-input=${JSON.stringify(sessionId)}]`)
    .locator('xpath=ancestor::*[@data-testid="message-input-row"][1]/parent::*')
    .locator('img[src^="blob:"]')
    .first();
  await preview.waitFor({ state: 'attached', timeout: 15_000 });
  assert.ok(
    await preview.evaluate((element) => element.checkVisibility({ opacityProperty: true })),
    'the attachment preview must be visible to the user',
  );
}

/** How many attachment previews sit in one session's composer. */
async function previewCountFor(page, sessionId) {
  return page.evaluate((id) => {
    const textarea = document.querySelector(`textarea[data-session-input="${id}"]`);
    const composer = textarea?.closest('[data-testid="message-input-row"]')?.parentElement;
    return composer ? composer.querySelectorAll('img[src^="blob:"]').length : -1;
  }, sessionId);
}

async function attachImage(page, sessionId) {
  await fileInputFor(page, sessionId).setInputFiles(imagePath);
  // The image is read asynchronously (FileReader) before it becomes an attachment.
  await page.waitForFunction(
    (id) => {
      const textarea = document.querySelector(`textarea[data-session-input="${id}"]`);
      const composer = textarea?.closest('[data-testid="message-input-row"]')?.parentElement;
      return Boolean(composer?.querySelector('img[src^="blob:"]'));
    },
    sessionId,
    { timeout: 15_000 },
  );
}

/**
 * The file input belonging to one session's composer. More than one session can
 * be open at once, and each brings its own — a page-wide `first()` would attach
 * the image to whichever composer happens to come first in the document.
 */
function fileInputFor(page, sessionId) {
  return page.locator(`textarea[data-session-input=${JSON.stringify(sessionId)}]`)
    .locator('xpath=ancestor::*[@data-testid="message-input-row"][1]/parent::*')
    .locator('input[type="file"]')
    .first();
}

async function waitForSendFrame(page, frames) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (frames.length > 0) return frames[0];
    await page.waitForTimeout(100);
  }
  throw new Error('the composer sent no send_message frame');
}

// --------------------------------------------------------------- fixtures ---

/**
 * One ordinary git repository plus the image to attach. Nothing is committed —
 * the project only has to be something the app will accept, list, and open a
 * session on.
 */
async function prepareFixture() {
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# attachment e2e\n', 'utf8');
  await fs.writeFile(imagePath, Buffer.from(PNG_BASE64, 'base64'));
}

/**
 * The account the browser's cookie will name. Written before the server starts,
 * because the request gate looks the token's subject up in this file and an
 * Electron-runtime server creates no account of its own.
 */
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

async function registerProject() {
  // The fixture lives on the Linux filesystem, so the server has to be told to
  // treat paths that way before it will accept the folder.
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ agentEnvironment: 'wsl' }),
  });
  assert.equal(settings.ok, true, `could not set the agent environment: ${settings.text}`);

  const project = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ folderPath: projectDir }),
  });
  assert.equal(project.ok, true, `could not register ${projectDir}: ${project.text}`);
}

/**
 * One chat session, which is what puts the composer on screen. The CLI is never
 * spawned: the frame under test is read at the socket on its way out.
 */
async function createSession(title) {
  const response = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workDir: projectDir,
      parentProjectId: projectDir,
      providerId: 'claude-code',
      // The composer belongs to the chat view; a pty session shows a terminal
      // surface and no textarea at all.
      executionMode: 'gui',
      title,
      hasCustomTitle: true,
    }),
  });
  assert.equal(response.ok, true, `could not create a session: ${response.text}`);
  const id = response.json?.sessionId ?? response.json?.session?.id ?? response.json?.id;
  assert.ok(id, `the session response carried no id: ${response.text}`);
  return id;
}

// ----------------------------------------------------------------- browser ---

/** The shared wave context: 360x776 with touch enabled (spec #241, height #265). */
async function openPhonePage() {
  return preparePage(await createPhoneContext(browser, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  }));
}

async function openDesktopPage() {
  return preparePage(await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    hasTouch: false,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  }));
}

async function preparePage(context) {
  const token = await mintBrowserToken();
  await context.addCookies([
    { name: 'jwt', value: token, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (error) => serverOutput.push(`[renderer:error] ${error.stack ?? error.message}\n`));

  // The outgoing frame is the seam. Reading it at the socket is what QA did, and
  // it is the only place that shows what the client actually transmitted.
  const frames = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      try {
        const message = JSON.parse(payload);
        if (message?.type === 'send_message') frames.push(message);
      } catch {
        // Non-JSON frames are outside this contract.
      }
    });
  });

  return { context, frames, page };
}

/**
 * Opens a session's chat view and returns its composer textarea.
 *
 * 'load' rather than 'domcontentloaded': the composer has to be laid out before
 * it can be typed into, and an unstyled page is not.
 */
async function openComposer(page, sessionId) {
  if (!page.url().includes('/chat')) {
    await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });

    const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
    await strip.waitFor({ state: 'visible', timeout: 30_000 });
    await strip.click();
  }

  // The expand control only exists while the sidebar is collapsed, which the
  // shell forces below 1024px and remembers across contexts.
  const expand = page.locator('[data-testid="tab-bar-sidebar-toggle"]');
  await page.waitForTimeout(500);
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }

  const row = page.locator(`[data-testid="collection-chat-${sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();

  const textarea = page.locator(
    `textarea[data-session-input=${JSON.stringify(sessionId)}]`,
  ).first();
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  return textarea;
}

// ------------------------------------------------------------------ server ---

async function startServer() {
  const env = { ...process.env };
  // This suite may itself be running inside Tessera; nothing about the host
  // app's session may leak into the server under test.
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
  ]) {
    delete env[key];
  }

  server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      // Without this the browser's WebSocket is refused — `extraHTTPHeaders`
      // does not reach an upgrade request — and the frame under test is never
      // sent at all.
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
      PORT: String(port),
      TESSERA_DEV_PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      serverOutput.push(chunk.toString());
      if (serverOutput.length > 400) serverOutput.shift();
    });
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`the isolated server exited with code ${server.exitCode}\n${logs()}`);
    }
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const response = await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      });
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for the isolated server at ${origin}\n${logs()}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    if (server.pid && process.platform !== 'win32') {
      process.kill(-server.pid, 'SIGTERM');
    } else {
      server.kill('SIGTERM');
    }
  } catch {
    // The server may already have exited.
  }
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
  ]);
  if (outcome === 'timeout' && server.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // The process exited between the timeout and the forced cleanup.
    }
    await exited;
  }
}

async function api(pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': appSecret,
      // Mutating routes check the origin; fetch does not set one for us the way
      // a browser would.
      origin,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
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
