// Ticket #245 — the app shell is sized to the visible viewport.
//
// What this file cannot cover: Playwright raises no real soft keyboard and does not
// emulate `interactive-widget`, so neither "the input bar rises above the keyboard" nor
// "no alt-screen content is lost across a keyboard toggle" is settled here. Both are
// device-only. The meta assertion below records that the browser was told to shrink the
// layout viewport; it does not stand in for watching it happen on a phone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { PHONE_VIEWPORT, createPhoneContext } from './helpers/phone-viewport.mjs';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-mobile-shell-'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

// The server runs from the repository itself, not from a copy: every assertion here is a
// measured height, and Tailwind only generates the utility layer for the source tree it
// is pointed at. A copied app root serves the page unstyled, and an unstyled shell
// measures as its content.
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
  await testRestoredSessionWaitsForProjectCatalog(browser, appOrigin);
  await testKeyboardShrinksTheLayoutViewport(browser, appOrigin);
  await testPhoneShellFillsTheVisibleViewport(browser, appOrigin);
  await testTallPanelScrollsInsideItsOwnBox(browser, appOrigin);
  await testDesktopShellIsUnchanged(browser, appOrigin);
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

async function testRestoredSessionWaitsForProjectCatalog(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);
  const projectDir = '/home/tester/restored-project';
  const sessionId = 'restored-session';
  const tabId = 'restored-tab';
  const panelId = 'restored-panel';
  let releaseProjects;
  const projectsGate = new Promise((resolve) => {
    releaseProjects = resolve;
  });
  let projectsRequested;
  const projectsRequest = new Promise((resolve) => {
    projectsRequested = resolve;
  });

  try {
    await page.addInitScript(({ projectDir: restoredProjectDir, sessionId: restoredSessionId, tabId: restoredTabId, panelId: restoredPanelId }) => {
      localStorage.setItem('ccw:selectedProjectDir', restoredProjectDir);
      sessionStorage.setItem('activeSessionId', restoredSessionId);
      localStorage.setItem('tessera-tab-store', JSON.stringify({
        version: 3,
        currentProjectDir: restoredProjectDir,
        activeTabId: restoredTabId,
        projects: {
          [restoredProjectDir]: {
            tabs: [{
              id: restoredTabId,
              projectDir: restoredProjectDir,
              snapshot: {
                layout: { type: 'leaf', panelId: restoredPanelId },
                panels: {
                  [restoredPanelId]: { id: restoredPanelId, sessionId: restoredSessionId },
                },
                activePanelId: restoredPanelId,
              },
              title: null,
              isPreview: false,
            }],
            activeTabId: restoredTabId,
          },
        },
        global: null,
      }));
    }, { projectDir, sessionId, tabId, panelId });

    await page.route('**/api/sessions/projects', async (route) => {
      projectsRequested();
      await projectsGate;
      await route.fulfill(jsonResponse({
        projects: [{
          encodedDir: projectDir,
          displayName: 'restored-project',
          decodedPath: projectDir,
          displayPath: projectDir,
          isCurrent: true,
          sessions: [{
            id: sessionId,
            title: 'Restored mobile session',
            projectDir,
            isRunning: false,
            status: 'completed',
            lastModified: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            provider: 'codex',
            kind: 'chat',
          }],
          totalSessions: 1,
          allLoaded: true,
          loadedCount: 1,
          nextCursor: null,
          countByStatus: {},
          cursorByStatus: {},
        }],
      }));
    });
    await page.route(`**/api/sessions/${sessionId}/messages**`, async (route) => {
      await route.fulfill(jsonResponse({
        messages: [],
        pagination: { hasMore: false, nextBeforeBytes: null },
      }));
    });

    await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
    await projectsRequest;
    await page.getByTestId('chat-skeleton').waitFor();
    assert.equal(
      await page.getByText('Session not found', { exact: true }).count(),
      0,
      'a restored tab must not be declared missing while the project catalog is loading',
    );

    releaseProjects();
    await page.getByRole('heading', { name: 'Restored mobile session' }).waitFor();
  } finally {
    releaseProjects?.();
    await context.close();
  }
}

// Evidence for the device-only criteria, not a substitute for them: the page has to ask
// the browser to shrink the layout viewport before a phone can be watched doing it.
async function testKeyboardShrinksTheLayoutViewport(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openChat(page, origin);
    const viewportMeta = await page.evaluate(() => (
      document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null
    ));

    assert.ok(viewportMeta, 'the app must declare a viewport meta');
    assert.match(
      viewportMeta,
      /interactive-widget=resizes-content/,
      'the soft keyboard must shrink the layout viewport, not only the visual viewport',
    );
    assert.match(
      viewportMeta,
      /width=device-width/,
      'declaring a viewport must not drop the device-width default',
    );
  } finally {
    await context.close();
  }
}

async function testPhoneShellFillsTheVisibleViewport(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    await openChat(page, origin);
    const layout = await documentLayout(page);

    assert.equal(
      layout.viewportHeight,
      PHONE_VIEWPORT.height,
      'the phone context should report the viewport height it was created with',
    );
    assert.ok(
      layout.documentScrollHeight <= layout.viewportHeight + 1,
      `the document must not scroll vertically at ${PHONE_VIEWPORT.width}x${PHONE_VIEWPORT.height}`
        + ` (content ${layout.documentScrollHeight}px in ${layout.viewportHeight}px)`,
    );
    assert.ok(
      Math.abs(layout.shellHeight - layout.viewportHeight) <= 1,
      `the app shell must fill the visible viewport exactly`
        + ` (shell ${layout.shellHeight}px, viewport ${layout.viewportHeight}px)`,
    );
  } finally {
    await context.close();
  }
}

async function testTallPanelScrollsInsideItsOwnBox(browserInstance, origin) {
  const { context, page } = await createPhonePage(browserInstance);

  try {
    // Enough entries that the list is several screens tall at the phone height.
    await page.route('**/api/filesystem/browse**', async (route) => {
      await route.fulfill(jsonResponse(browsePayload('/home/tester', 60)));
    });

    await openChat(page, origin);
    await page.getByTestId('project-strip-add').click();
    await page.getByTestId('folder-browser-dialog').waitFor();
    await page.getByTestId('folder-browser-entry').first().waitFor();

    const dialogBox = await page.getByTestId('folder-browser-dialog').boundingBox();
    assert.ok(dialogBox, 'the add-project dialog should be measurable');
    assert.ok(
      dialogBox.y >= -1 && dialogBox.y + dialogBox.height <= PHONE_VIEWPORT.height + 1,
      `the add-project dialog must fit vertically inside the viewport`
        + ` (top ${dialogBox.y}px, bottom ${dialogBox.y + dialogBox.height}px)`,
    );

    const list = page.getByTestId('folder-browser-list');
    const overflowsItsBox = await list.evaluate((element) => (
      element.scrollHeight > element.clientHeight
    ));
    assert.ok(overflowsItsBox, 'the fixture should make the list taller than its own box');

    await list.evaluate((element) => { element.scrollTop = 240; });
    const scrolled = await list.evaluate((element) => element.scrollTop);
    assert.ok(scrolled > 0, 'a panel taller than the screen must scroll inside its own box');

    const layout = await documentLayout(page);
    assert.ok(
      layout.documentScrollHeight <= layout.viewportHeight + 1,
      'scrolling a panel must not turn the document into the scroll container',
    );
    assert.equal(layout.documentScrollTop, 0, 'the document itself must stay put');
  } finally {
    await context.close();
  }
}

// The overriding constraint for this wave: the desktop layout must not regress.
async function testDesktopShellIsUnchanged(browserInstance, origin) {
  const context = await browserInstance.newContext({
    viewport: DESKTOP_VIEWPORT,
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  const page = await context.newPage();

  try {
    await openChat(page, origin);
    const layout = await documentLayout(page);

    assert.equal(
      layout.viewportHeight,
      DESKTOP_VIEWPORT.height,
      'the desktop context should report the viewport height it was created with',
    );
    assert.ok(
      Math.abs(layout.shellHeight - layout.viewportHeight) <= 1,
      `dvh must equal vh on a desktop viewport`
        + ` (shell ${layout.shellHeight}px, viewport ${layout.viewportHeight}px)`,
    );
    assert.ok(
      layout.documentScrollHeight <= layout.viewportHeight + 1,
      'the desktop document must not scroll vertically',
    );
  } finally {
    await context.close();
  }
}

async function documentLayout(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="chat-layout"]');
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      viewportHeight: window.innerHeight,
      documentScrollHeight: scroller.scrollHeight,
      documentScrollTop: scroller.scrollTop,
      shellHeight: shell ? shell.getBoundingClientRect().height : null,
    };
  });
}

async function createPhonePage(browserInstance) {
  const context = await createPhoneContext(browserInstance, {
    extraHTTPHeaders: { 'x-tessera-app-secret': appSecret },
  });
  const page = await context.newPage();
  return { context, page };
}

async function openChat(page, origin) {
  // 'load' rather than 'domcontentloaded': every height here is a styled height, and an
  // unstyled shell measures as its content instead of as the viewport.
  await page.goto(`${origin}/chat`, { waitUntil: 'load', timeout: 60_000 });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
}

function browsePayload(currentPath, entryCount) {
  return {
    currentPath,
    filesystemPath: currentPath,
    parentPath: '/home',
    entries: Array.from({ length: entryCount }, (_, index) => ({
      name: `folder-${String(index).padStart(3, '0')}`,
      path: `${currentPath}/folder-${String(index).padStart(3, '0')}`,
      isDirectory: true,
      isGitRepo: false,
    })),
    isGitRepo: false,
  };
}

function jsonResponse(body, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
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
