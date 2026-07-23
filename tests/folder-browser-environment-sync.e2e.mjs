import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = path.join(os.homedir(), 'tmp');
await fs.mkdir(tempRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(tempRoot, 'tessera-folder-browser-env-'));
const appRoot = path.join(dataDir, 'app');
await fs.mkdir(appRoot);
await Promise.all([
  'next.config.mjs',
  'package.json',
  'public',
  'runtime',
  'server.ts',
  'src',
  'tsconfig.json',
].map((entry) => hardlinkCopy(path.join(repoRoot, entry), path.join(appRoot, entry))));
await hardlinkCopy(path.join(repoRoot, 'node_modules'), path.join(appRoot, 'node_modules'));
const port = await reservePort();
const appOrigin = `http://127.0.0.1:${port}`;
let serverOutput = '';

const server = spawn(
  process.execPath,
  [path.join(appRoot, 'node_modules/tsx/dist/cli.mjs'), 'server.ts'],
  {
    cwd: appRoot,
    detached: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      TESSERA_DATA_DIR: dataDir,
      TESSERA_ELECTRON_AUTH_BYPASS: '1',
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
try {
  await waitForServer(`${appOrigin}/api/settings`, server);

  browser = await chromium.launch({ headless: true });
  await testWaitsForAuthoritativeNative(browser, appOrigin);
  await testUsesAuthoritativeWsl(browser, appOrigin);
  await testIgnoresBrowseFromPreviousOpen(browser, appOrigin);
  await testReinitializesAfterEnvironmentChange(browser, appOrigin);
  await testStopsWhenSettingsLoadFails(browser, appOrigin);
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

async function testWaitsForAuthoritativeNative(browserInstance, origin) {
  const { context, page } = await createElectronPage(browserInstance, 'wsl');
  const settingsGate = createDeferred();
  const browseRequests = collectBrowseRequests(page);

  try {
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'GET') await settingsGate.promise;
      await route.continue();
    });

    await openAddProject(page, origin);

    // A hard-coded native request would make the original one-way assertion
    // pass, but it is still unsafe until the server setting has resolved.
    await page.waitForTimeout(200);
    assert.equal(
      browseRequests.length,
      0,
      'Add Project must not browse before authoritative settings resolve',
    );
    settingsGate.resolve();

    await waitForPathValue(page);
    assert.equal(
      getRequestEnvironment(browseRequests[0]),
      'native',
      'a stale WSL renderer must adopt the server-authoritative native environment',
    );
    assert.equal(
      await page.getByText(/Current Agent Environment is .*Switch Agent Environment/).count(),
      0,
      'the authoritative home browse must not render an environment mismatch',
    );
    assert.equal(
      await page.getByTestId('folder-browser-environment-native').isDisabled(),
      false,
      'the native control must agree with the authoritative settings',
    );
  } finally {
    settingsGate.resolve();
    await context.close();
  }
}

async function testUsesAuthoritativeWsl(browserInstance, origin) {
  const { context, page } = await createElectronPage(browserInstance, 'native');
  const settingsGate = createDeferred();
  const browseRequests = collectBrowseRequests(page);

  try {
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'GET') await settingsGate.promise;
      await route.fulfill(jsonResponse(settingsPayload('wsl')));
    });
    await page.route('**/api/filesystem/browse**', async (route) => {
      await route.fulfill(jsonResponse(browsePayload('/home/wsl-user')));
    });

    await openAddProject(page, origin);
    await page.waitForTimeout(200);
    assert.equal(
      browseRequests.length,
      0,
      'the opposite stale-cache direction must also wait for settings',
    );
    settingsGate.resolve();

    await waitForPathValue(page, '/home/wsl-user');
    assert.equal(
      getRequestEnvironment(browseRequests[0]),
      'wsl',
      'a stale native renderer must adopt the server-authoritative WSL environment',
    );
    assert.equal(
      await page.getByTestId('folder-browser-environment-wsl').isDisabled(),
      false,
      'the WSL control must agree with the authoritative settings',
    );
  } finally {
    settingsGate.resolve();
    await context.close();
  }
}

async function testIgnoresBrowseFromPreviousOpen(browserInstance, origin) {
  const { context, page } = await createElectronPage(browserInstance, 'native');
  const firstBrowseStarted = createDeferred();
  const releaseFirstBrowse = createDeferred();
  let browseCount = 0;

  try {
    await page.route('**/api/settings', async (route) => {
      await route.fulfill(jsonResponse(settingsPayload('native')));
    });
    await page.route('**/api/filesystem/browse**', async (route) => {
      browseCount += 1;
      if (browseCount === 1) {
        firstBrowseStarted.resolve();
        await releaseFirstBrowse.promise;
        await route.fulfill(jsonResponse(browsePayload('C:\\stale-home'))).catch(() => undefined);
        return;
      }
      await route.fulfill(jsonResponse(browsePayload('C:\\fresh-home')));
    });

    await openAddProject(page, origin);
    await withTimeout(firstBrowseStarted.promise, 10_000, 'first browse request');
    await page.getByTestId('folder-browser-cancel').click();
    await page.getByTestId('folder-browser-dialog').waitFor({ state: 'hidden' });

    await page.getByTestId('project-strip-add').click();
    await page.getByTestId('folder-browser-dialog').waitFor();
    await waitForPathValue(page, 'C:\\fresh-home');

    releaseFirstBrowse.resolve();
    await page.waitForTimeout(200);
    assert.equal(
      await page.getByTestId('folder-browser-path-input').inputValue(),
      'C:\\fresh-home',
      'a late response from the previous open must not replace the current directory',
    );
  } finally {
    releaseFirstBrowse.resolve();
    await context.close();
  }
}

async function testStopsWhenSettingsLoadFails(browserInstance, origin) {
  const { context, page } = await createElectronPage(browserInstance, 'wsl');
  const browseRequests = collectBrowseRequests(page);

  try {
    await page.route('**/api/settings', async (route) => {
      await route.fulfill(jsonResponse({ error: 'settings unavailable' }, 503));
    });
    await page.route('**/api/filesystem/browse**', async (route) => {
      await route.fulfill(jsonResponse({ error: 'unexpected browse request' }, 500));
    });

    await openAddProject(page, origin);
    await page.getByText('Failed to load settings').waitFor({ timeout: 10_000 });
    const pathInput = page.getByTestId('folder-browser-path-input');
    await pathInput.fill('C:\\stale-home');
    await pathInput.press('Enter');
    await page.waitForTimeout(100);
    assert.equal(
      browseRequests.length,
      0,
      'Add Project must not browse with a stale persisted environment after settings fail',
    );
  } finally {
    await context.close();
  }
}

async function testReinitializesAfterEnvironmentChange(browserInstance, origin) {
  const { context, page } = await createElectronPage(browserInstance, 'native');
  const browseRequests = collectBrowseRequests(page);

  try {
    await page.route('**/api/settings', async (route) => {
      await route.fulfill(jsonResponse(settingsPayload('native')));
    });
    await page.route('**/api/filesystem/browse**', async (route) => {
      const environment = new URL(route.request().url()).searchParams.get('environment');
      const currentPath = environment === 'wsl' ? '/home/wsl-user' : 'C:\\native-home';
      await route.fulfill(jsonResponse(browsePayload(currentPath)));
    });

    await openAddProject(page, origin);
    await waitForPathValue(page, 'C:\\native-home');
    const initialBrowseCount = browseRequests.length;

    await page.evaluate(() => {
      const channel = new BroadcastChannel('tessera:settings-sync');
      channel.postMessage({
        type: 'settings-updated',
        settings: { agentEnvironment: 'wsl' },
        senderId: 'folder-browser-e2e-external-renderer',
      });
      channel.close();
    });

    await waitForPathValue(page, '/home/wsl-user');
    assert.ok(
      browseRequests.length > initialBrowseCount,
      'an Agent Environment change must start a fresh home browse',
    );
    assert.equal(
      getRequestEnvironment(browseRequests.at(-1)),
      'wsl',
      'the refreshed browse must use the newly synchronized Agent Environment',
    );
  } finally {
    await context.close();
  }
}

async function createElectronPage(browserInstance, persistedEnvironment) {
  const context = await browserInstance.newContext({ viewport: { width: 1200, height: 850 } });
  await context.addInitScript((environment) => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { isElectron: true, platform: 'win32' },
    });
    localStorage.setItem('tessera:settings', JSON.stringify({
      state: {
        settings: { agentEnvironment: environment },
      },
      version: 0,
    }));
  }, persistedEnvironment);
  const page = await context.newPage();
  return { context, page };
}

async function openAddProject(page, origin) {
  await page.goto(`${origin}/chat`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.getByTestId('chat-layout').waitFor({ timeout: 30_000 });
  await page.getByTestId('project-strip-add').click();
  await page.getByTestId('folder-browser-dialog').waitFor();
}

function collectBrowseRequests(page) {
  const requests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/filesystem/browse') {
      requests.push(request.url());
    }
  });
  return requests;
}

async function waitForPathValue(page, expectedValue = null) {
  await page.getByTestId('folder-browser-path-input').waitFor();
  await page.waitForFunction((expected) => {
    const input = document.querySelector('[data-testid="folder-browser-path-input"]');
    if (!(input instanceof HTMLInputElement)) return false;
    return expected === null ? input.value.length > 0 : input.value === expected;
  }, expectedValue, { timeout: 10_000 });
}

function getRequestEnvironment(requestUrl) {
  assert.ok(requestUrl, 'opening Add Project must browse the home directory');
  return new URL(requestUrl).searchParams.get('environment');
}

function settingsPayload(agentEnvironment) {
  return {
    settings: { agentEnvironment },
    serverHostInfo: { isWindowsEcosystem: true },
  };
}

function browsePayload(currentPath) {
  return {
    currentPath,
    filesystemPath: currentPath,
    parentPath: null,
    entries: [],
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

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function hardlinkCopy(source, destination) {
  await new Promise((resolve, reject) => {
    const copy = spawn('cp', ['-al', source, destination], { stdio: 'ignore' });
    copy.once('error', reject);
    copy.once('exit', (code) => (
      code === 0 ? resolve() : reject(new Error(`cp -al exited with code ${code}`))
    ));
  });
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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for isolated Tessera server at ${url}`);
}
