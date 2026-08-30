/**
 * The PTY chat composer's placeholder fits the one line the box is tall (issue #271).
 *
 * The textarea is `rows={1}` and its placeholder was a whole sentence — "Send text to the
 * terminal". At 360px the box is 204px wide, so the full accessible label
 * wrapped onto a second line `overflow: auto` hid (`clientHeight` 28, `scrollHeight` 48).
 * A placeholder cannot be scrolled into view, so what a user read stopped mid-sentence.
 *
 * Two claims per surface. `scrollHeight <= clientHeight` for the empty composer is the
 * assertion the ticket asked for, so the next string that grows past one line fails here
 * instead of clipping silently; and the sentence has to still be the input's accessible
 * name, because shortening the visible hint is the fix and dropping what it said is not.
 *
 * Both font scales a phone offers (1.375 is out of scope, #269) — the defect is worse at
 * the default, a whole 20px line, than at the 0.8125 the ticket measured — and a desktop
 * check, because the same component renders above the phone step. Not asserted: the
 * blocked placeholder, clipped the same way and shortened by the same change, which shows
 * only while the TUI owns the input line — no fixture reaches that without a live agent
 * prompting for permission, so its numbers are on the ticket instead.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { startDevServer, putSettings } from './helpers/dev-server.mjs';

const run = promisify(execFile);

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
/** The default, and the smallest preset a phone offers — 1.375 is out of scope (#269). */
const FONT_SCALES = [1, 0.8125];
/**
 * What the shortened hint may not quietly drop. Written out rather than imported from
 * `en.ts` on purpose: reading it from the same file the page reads would pass whatever
 * that file said, which is the copy edit this is here to catch.
 */
const FULL_SENTENCE = 'Send text or file paths to the terminal';
const BROWSER_USER_ID = 'e2e-browser-user';

const artifactDir = process.env.TESSERA_E2E_ARTIFACT_DIR
  ?? path.join(os.tmpdir(), 'tessera-chat-placeholder-e2e');

let dev = null;
let browser = null;
let fixtureDir = null;
let projectDir = null;
let sessionId = null;

/** The account the browser's cookie names; the request gate looks it up in this file. */
async function seedBrowserUser(dataDir) {
  const now = new Date().toISOString();
  const user = { id: BROWSER_USER_ID, username: 'e2e', passwordHash: 'unused', createdAt: now, lastLoginAt: now };
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify({ users: [user] }), 'utf8');
}

async function mintToken() {
  const privateKey = await fs.readFile(path.join(dev.dataDir, 'auth', 'private.pem'), 'utf8');
  return jwt.sign({ sub: BROWSER_USER_ID, username: 'e2e', iss: 'tessera', aud: 'tessera-users' },
    privateKey, { algorithm: 'RS256', expiresIn: 3600 });
}

async function api(pathname, body) {
  const response = await fetch(`${dev.origin}${pathname}`, {
    method: 'POST',
    // Mutating routes check the origin; `fetch` does not set one for us.
    headers: {
      'content-type': 'application/json',
      'x-tessera-app-secret': dev.appSecret,
      origin: dev.origin,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, `POST ${pathname} failed: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** One PTY session on an ordinary git repository. No runtime is spawned by creating it. */
async function prepareFixture() {
  fixtureDir = await fs.mkdtemp(path.join(os.homedir(), 'tmp', 'tessera-placeholder-fixture-'));
  projectDir = path.join(fixtureDir, 'placeholder-e2e');
  await fs.mkdir(projectDir, { recursive: true });
  await run('git', ['init', '-b', 'main', projectDir]);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# placeholder e2e\n', 'utf8');

  // The fixture is on the Linux filesystem, so the server has to be told to read paths
  // that way before it will accept the folder.
  await putSettings(dev, { agentEnvironment: 'wsl' });
  await api('/api/projects', { folderPath: projectDir });
  const session = await api('/api/sessions', {
    workDir: projectDir, parentProjectId: projectDir, providerId: 'claude-code',
    executionMode: 'pty', title: 'placeholder e2e', hasCustomTitle: true,
  });
  sessionId = session?.sessionId ?? session?.session?.id ?? session?.id;
  assert.ok(sessionId, 'the session response carried no id');
}

/** Opens the fixture session's chat overlay, with the composer on screen. */
async function openComposer({ phone, fontScale }) {
  await putSettings(dev, { fontSize: fontScale, language: 'en' });

  const options = { extraHTTPHeaders: { 'x-tessera-app-secret': dev.appSecret } };
  const context = phone
    ? await createPhoneContext(browser, options)
    : await browser.newContext({ ...options, viewport: DESKTOP_VIEWPORT, hasTouch: false });
  await context.addCookies([
    { name: 'jwt', value: await mintToken(), domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  await context.addInitScript(() => {
    // A phone commonly reaches Tessera over a LAN HTTP origin, where Chromium does not
    // expose secure-context-only Web Crypto helpers such as randomUUID().
    Object.defineProperty(Crypto.prototype, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    const nativeSend = WebSocket.prototype.send;
    window.__terminalSubmitFrames = [];
    WebSocket.prototype.send = function captureTerminalSubmit(data) {
      try {
        const frame = JSON.parse(String(data));
        if (frame?.type === 'terminal_prompt') window.__terminalSubmitFrames.push(frame);
      } catch {
        // Non-JSON frames are unrelated terminal traffic.
      }
      return nativeSend.call(this, data);
    };
  });

  const page = await context.newPage();
  // 'load' rather than 'domcontentloaded': an unstyled textarea measures as its content.
  await page.goto(`${dev.origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForSelector('[data-testid="chat-layout"]', { timeout: 60_000 });

  const strip = page.locator(`[data-testid="project-strip-${projectDir}"]`);
  await strip.waitFor({ state: 'visible', timeout: 30_000 });
  await strip.click();
  // The expand control exists only while the sidebar is collapsed, which the shell forces
  // below 1024px and remembers across contexts.
  const expand = page.getByTestId('tab-bar-sidebar-toggle');
  await page.waitForTimeout(500);
  if (await expand.isVisible().catch(() => false)) await expand.click();

  const row = page.locator(`[data-testid="collection-chat-${sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.click();
  // At 360px the sidebar takes the whole width, and a composer behind it is not the one a
  // user is looking at.
  const collapse = page.getByTestId('sidebar-collapse-btn');
  if (await collapse.isVisible().catch(() => false)) await collapse.click();

  await page.getByTestId('terminal-view-toggle').click();
  await page.getByTestId('terminal-chat-overlay').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('terminal-chat-composer-input').waitFor({ state: 'visible', timeout: 30_000 });
  // The font scale has to have settled before anything is measured.
  await page.waitForTimeout(300);
  return { context, page };
}

/** The empty composer's own box, and the name the whole sentence has to survive in. */
function measure(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="terminal-chat-composer-input"]');
    return {
      value: el.value,
      width: Math.round(el.getBoundingClientRect().width * 100) / 100,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      lineHeight: getComputedStyle(el).lineHeight,
      placeholder: el.placeholder,
      accessibleName: el.getAttribute('aria-label'),
      rootFont: getComputedStyle(document.documentElement).fontSize,
    };
  });
}

/** One surface at one font scale. */
async function check({ phone, fontScale, name }) {
  const { context, page } = await openComposer({ phone, fontScale });
  try {
    const box = await measure(page);
    assert.equal(box.value, '', 'the composer under test has to be empty');
    const geometry = `${box.width}px wide, clientHeight ${box.clientHeight},`
      + ` scrollHeight ${box.scrollHeight}, lineHeight ${box.lineHeight},`
      + ` root font ${box.rootFont}, placeholder ${JSON.stringify(box.placeholder)}`;

    if (box.scrollHeight > box.clientHeight) {
      // A failure is looked at, not only read: the clipped second line shows as stray
      // strokes under the first, which no number conveys.
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({ path: path.join(artifactDir, `clipped-${name}.png`) }).catch(() => {});
    }
    assert.ok(
      box.scrollHeight <= box.clientHeight,
      `the empty composer's placeholder needs a line the box does not have, and a`
        + ` placeholder cannot be scrolled into view — ${geometry}`,
    );
    assert.equal(
      box.accessibleName,
      FULL_SENTENCE,
      'the shortened hint dropped what the sentence said instead of moving it to the'
        + ` input's accessible name (got ${JSON.stringify(box.accessibleName)})`,
    );

    const input = page.getByTestId('terminal-chat-composer-input');
    await input.fill('one line');
    const singleLine = await measure(page);
    await input.fill('one line\ntwo lines\nthree lines\nfour lines');
    const fourLines = await measure(page);
    assert.ok(
      fourLines.clientHeight >= singleLine.clientHeight + Number.parseFloat(singleLine.lineHeight) * 2,
      'the PTY ChatView composer did not grow with multiline input'
        + ` — ${singleLine.clientHeight}px for one line, ${fourLines.clientHeight}px for four lines`,
    );

    await input.fill('hello from PTY chat view');
    await page.getByTestId('terminal-chat-composer-send').click();
    await page.waitForFunction(() => window.__terminalSubmitFrames.length > 0, null, {
      timeout: 2_000,
    });
    const frames = await page.evaluate(() => window.__terminalSubmitFrames);
    assert.equal(frames.at(-1)?.text, 'hello from PTY chat view');

    console.log(`ok — ${name}: ${geometry}`);
  } finally {
    await context.close();
  }
}

try {
  dev = await startDevServer({
    dataDirPrefix: 'tessera-placeholder-data-',
    seed: seedBrowserUser,
    // Without this the browser's WebSocket is refused — `extraHTTPHeaders` does not reach
    // an upgrade request — and the sidebar never receives the session list.
    env: { TESSERA_ELECTRON_AUTH_BYPASS: '1' },
  });
  await prepareFixture();
  browser = await launchPhoneBrowser();

  for (const fontScale of FONT_SCALES) {
    await check({ phone: true, fontScale, name: `phone ${PHONE_VIEWPORT.width}px @${fontScale}` });
  }
  // The same component above the phone step, where the box was always wide enough.
  await check({ phone: false, fontScale: 1, name: `desktop ${DESKTOP_VIEWPORT.width}px @1` });
} finally {
  await browser?.close().catch(() => undefined);
  await dev?.stop();
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
}
