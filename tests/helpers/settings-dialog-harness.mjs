// Booting a server and opening the Settings dialog on it — the plumbing every
// Settings e2e in the phone-usability wave repeats verbatim. Split out so a ticket's
// own file is the claim it makes and nothing else (#267).
//
// The server runs from the repository rather than a copied app root on purpose:
// these tests measure styled boxes, and Tailwind only builds its utility layer for
// the tree it is pointed at, so a copy serves the page unstyled (#252).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createPhoneContext, createPhoneContextWithAddressBarHidden } from './phone-viewport.mjs';

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const selected = listener.address().port;
  await new Promise((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve())));
  return selected;
}

/**
 * Boots the app on its own port and data directory and returns the two things a
 * ticket needs: a way to open Settings at a viewport and font scale, and a way to
 * shut it all down.
 *
 * Headful is not optional — a headless run renders through SwiftShader and reports
 * emulated device metrics, which invented one defect in this wave already (#256).
 *
 * `viewport` keeps the three states the files this was extracted from already
 * distinguish — the phone has two real content heights, not one (#265), and a helper
 * that could only say "phone" would be one no existing file could adopt.
 *
 * @returns {Promise<{ openSettingsPage: (options: {
 *   viewport: 'phone' | 'phone-address-bar-hidden' | 'desktop', fontScale: number,
 * }) => Promise<{ context: import('@playwright/test').BrowserContext,
 *                 page: import('@playwright/test').Page }>,
 *   logs: () => string, stop: () => Promise<void> }>}
 */
export async function startSettingsHarness() {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const tempRoot = path.join(os.homedir(), 'tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-settings-e2e-'));
  const output = [];
  const logs = () => output.join('');

  const env = { ...process.env };
  // This suite may itself be running inside Tessera; nothing about the host app's
  // session may leak into the server under test.
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_CHILD', 'TESSERA_APP_ROOT', 'TESSERA_ELECTRON_SERVER',
    'TESSERA_PRODUCTION_DB', 'TESSERA_HOOK_PORT', 'TESSERA_PANE_TOKEN', 'TESSERA_SESSION_ID',
    'TESSERA_PROJECT_ID', 'TESSERA_WORKTREE_ID', '__CFBundleIdentifier',
  ]) delete env[key];

  const server = spawn(process.execPath, ['./node_modules/.bin/tsx', 'server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: {
      ...env,
      NODE_ENV: 'development',
      PORT: String(port),
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_RUNTIME: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      output.push(chunk.toString());
      if (output.length > 400) output.shift();
    });
  }

  let appSecret = null;
  let ready = false;
  const deadline = Date.now() + 180_000;
  while (!ready && Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    try {
      appSecret = (await fs.readFile(path.join(dataDir, 'auth', 'app-secret'), 'utf8')).trim();
      const probe = await fetch(`${origin}/api/settings`, {
        headers: { 'x-tessera-app-secret': appSecret },
      });
      ready = probe.ok;
    } catch {
      // Next is still starting.
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`server did not start:\n${logs()}`);

  const browser = await chromium.launch({ headless: false });

  /**
   * The font scale is set on the server *and* in localStorage: `ThemeInitializer`
   * writes `--font-scale` from the loaded settings, so seeding only localStorage
   * gets overwritten the moment the store hydrates.
   */
  async function openSettingsPage({ viewport, fontScale }) {
    const saved = await fetch(`${origin}/api/settings`, {
      method: 'PUT',
      // Mutating routes check the origin; `fetch` does not set one for us.
      headers: { 'content-type': 'application/json', 'x-tessera-app-secret': appSecret, origin },
      body: JSON.stringify({ fontSize: fontScale }),
    });
    assert.equal(saved.ok, true, `could not set the font scale: ${await saved.text()}`);

    const options = { extraHTTPHeaders: { 'x-tessera-app-secret': appSecret } };
    const context = viewport === 'phone'
      ? await createPhoneContext(browser, options)
      : viewport === 'phone-address-bar-hidden'
        ? await createPhoneContextWithAddressBarHidden(browser, options)
        : await browser.newContext({ ...options, viewport: DESKTOP_VIEWPORT, hasTouch: false });
    await context.addInitScript((scale) => {
      localStorage.setItem('tessera:settings', JSON.stringify({
        state: { settings: { fontSize: scale, theme: 'light' } },
        version: 0,
      }));
    }, fontScale);

    const page = await context.newPage();
    page.on('pageerror', (e) => output.push(`[renderer:error] ${e.stack ?? e.message}\n`));
    // 'load' rather than 'domcontentloaded': every box measured through this harness
    // is a styled box, and an unstyled control measures as its content.
    await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 90_000 });
    // These tests authenticate HTTP with the app-secret header, which a browser
    // cannot attach to a WebSocket upgrade. Keep the expected dev-only error overlay
    // from covering the controls being measured — the stylesheet stops it painting
    // over a measured box in the frames before the observer removes it.
    await page.addStyleTag({
      content: 'nextjs-portal { pointer-events: none !important; display: none !important; }',
    });
    await page.evaluate(() => {
      const remove = () => document.querySelectorAll('nextjs-portal').forEach((p) => p.remove());
      remove();
      new MutationObserver(remove).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByTestId('settings-modal').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('settings-section-general-execution-mode')
      .waitFor({ state: 'visible', timeout: 30_000 });
    // The font scale has to have settled before anything is measured.
    await page.waitForTimeout(300);
    return { context, page };
  }

  async function stop() {
    await browser.close();
    if (server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once('exit', resolve));
    try {
      if (process.platform === 'win32') server.kill('SIGTERM');
      else process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }

  return { openSettingsPage, logs, stop };
}
