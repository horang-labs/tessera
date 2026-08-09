import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startPhoneAppServer } from './phone-app-server.mjs';

const run = promisify(execFile);

/** Real dirty repository and bare remote used by issue 316's browser contract. */
export async function createGitPhoneDeliveryFixture() {
  const app = await startPhoneAppServer({ name: 'git-phone-delivery' });
  const git = (args, cwd = app.projectDir) => run('git', [
    '-c', 'user.email=e2e@tessera.test', '-c', 'user.name=E2E', ...args,
  ], { cwd });
  const remote = path.join(path.dirname(app.projectDir), 'remote.git');

  await git(['init', '--bare', '--initial-branch=main', remote], path.dirname(app.projectDir));
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'seed']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  await git(['remote', 'set-head', 'origin', 'main']);
  await fs.writeFile(path.join(app.projectDir, 'README.md'), '# changed\nplus one\n', 'utf8');
  await Promise.all(Array.from({ length: 100 }, (_, index) => fs.writeFile(
    path.join(app.projectDir, `phone-${String(index).padStart(3, '0')}.txt`),
    `line ${index}\n`,
    'utf8',
  )));

  return {
    app,
    artifactDir: process.env.TESSERA_E2E_ARTIFACT_DIR
      ?? path.join(os.homedir(), 'tmp', 'tessera-ticket-316'),
  };
}

/** Authenticated phone page with deterministic whole-worktree totals. */
export async function openGitPhoneDeliveryPage(app, context) {
  await context.addInitScript((projectDir) => {
    localStorage.setItem('ccw:selectedProjectDir', projectDir);
    localStorage.removeItem('tessera:git-panel');
  }, app.projectDir);
  const page = await app.preparePage(context);
  await page.route(`**/api/sessions/${app.sessionId}/git`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        diffStats: {
          added: 102,
          removed: 1,
          changedFiles: 101,
          newFiles: 100,
          deletedFiles: 0,
          computedAt: '2026-08-09T00:00:00.000Z',
        },
      },
    });
  });
  await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId('tab-bar').waitFor({ state: 'visible', timeout: 30_000 });
  return page;
}

export function measureVisibleHeaderControls(page) {
  return page.getByTestId('tab-bar').locator('button').evaluateAll((buttons) => (
    buttons.filter((button) => button.getBoundingClientRect().width > 0).map((button) => {
      const box = button.getBoundingClientRect();
      return { name: button.getAttribute('aria-label'), width: box.width, height: box.height };
    })
  ));
}

export function measureActionSheet(sheet) {
  return sheet.evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    viewport: window.innerHeight,
    paddingBottom: parseFloat(getComputedStyle(element).paddingBottom),
    rows: Array.from(element.querySelectorAll('[role="menuitem"]'))
      .map((row) => row.getBoundingClientRect().height),
    disabledReasons: Array.from(element.querySelectorAll('button:disabled span:last-child'))
      .map((span) => span.textContent?.trim()).filter(Boolean),
  }));
}

export function measureConfirmationSheet(sheet) {
  return sheet.evaluate((element) => ({
    bottom: element.getBoundingClientRect().bottom,
    viewport: window.innerHeight,
    paddingBottom: parseFloat(getComputedStyle(element).paddingBottom),
    buttons: Array.from(element.querySelectorAll('button')).map((button) => ({
      height: button.getBoundingClientRect().height,
      name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
    })),
  }));
}

export async function captureGitPhoneScreenshot(page, artifactDir, filename) {
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, filename) });
}

/** Holds the next Git mutation so the header's shared pending state is observable. */
export async function holdNextGitAction(page) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/git/action', async (route) => {
    await held;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"error":"held failure"}',
    });
  });
  return release;
}

/** Opens the existing desktop action menu for the phone-sheet non-regression. */
export async function openDesktopGitActionMenu(app, browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    hasTouch: false,
    extraHTTPHeaders: { 'x-tessera-app-secret': app.appSecret },
  });
  await context.addInitScript(
    (projectDir) => localStorage.setItem('ccw:selectedProjectDir', projectDir),
    app.projectDir,
  );
  const page = await app.preparePage(context);
  await page.goto(`${app.origin}/chat`, { waitUntil: 'load', timeout: 120_000 });
  await page.getByTestId('desktop-commit-control').waitFor({ timeout: 30_000 });
  await page.getByTestId('desktop-commit-menu-trigger').click();
  await page.getByTestId('desktop-commit-action-menu').waitFor();
  return { context, page };
}
