#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');

function readOption(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length) ?? null;
}

async function waitForPendingRequest(electronPage, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await electronPage.evaluate(() => window.electronAPI.listPairingRequests());
    assert.equal(result?.ok, true, result?.error ?? 'Electron could not list pairing requests');
    const pending = result.requests?.find((request) => request.status === 'pending');
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The packaged Electron app did not receive a pending pairing request');
}

async function createPairingLink(electronPage, origin) {
  const presentation = await electronPage.evaluate(() => (
    window.electronAPI.createPairingCode('rotate')
  ));
  assert.equal(presentation?.ok, true, presentation?.error ?? 'Pairing link creation failed');
  const advertisedLink = new URL(presentation.pairingLink);
  const token = new URLSearchParams(advertisedLink.hash.slice(1)).get('t');
  assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/);
  return `${origin}/pair#t=${token}`;
}

async function openPairingApprovalSurface(electronPage, origin) {
  const remoteAccessNavigation = electronPage.getByTestId('settings-nav-remote-access');
  if (!await remoteAccessNavigation.isVisible().catch(() => false)) {
    await electronPage.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  await remoteAccessNavigation.click();
  const addDevice = electronPage.getByRole('button', { name: 'Add device' });
  if (await addDevice.isVisible().catch(() => false)) await addDevice.click();
  const pairingLink = electronPage.locator('code').filter({ hasText: '/pair#t=' }).first();
  await pairingLink.waitFor({ timeout: 20_000 });
  const advertisedLink = new URL((await pairingLink.textContent() ?? '').trim());
  const token = new URLSearchParams(advertisedLink.hash.slice(1)).get('t');
  assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/);
  await electronPage.getByTestId('pairing-approval-requests').waitFor({ timeout: 20_000 });
  return `${origin}/pair#t=${token}`;
}

async function assertSessionAndWebSocketAccess(page) {
  const sessionApiStatus = await page.evaluate(() => (
    fetch('/api/sessions/projects', { cache: 'no-store' }).then((response) => response.status)
  ));
  assert.equal(sessionApiStatus, 200, 'The approved browser could not load its initial sessions');

  const websocketOpened = await page.evaluate(() => new Promise((resolve) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    const timeout = window.setTimeout(() => {
      socket.close();
      resolve(false);
    }, 10_000);
    socket.addEventListener('open', () => {
      window.clearTimeout(timeout);
      socket.close();
      resolve(true);
    }, { once: true });
    socket.addEventListener('error', () => {
      window.clearTimeout(timeout);
      resolve(false);
    }, { once: true });
  }));
  assert.equal(websocketOpened, true, 'The approved browser could not open the Tessera WebSocket');
}

async function openMobilePairing(browser, link) {
  const context = await browser.newContext({
    ...require(path.join(process.argv[2], 'node_modules', '@playwright', 'test')).devices['iPhone 13'],
    locale: 'en-US',
  });
  const page = await context.newPage();
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.getByTestId('pairing-waiting').waitFor({ timeout: 20_000 });
  } catch (error) {
    const safeUrl = new URL(page.url());
    safeUrl.hash = '';
    throw new Error(
      `Mobile pairing did not enter the waiting state at ${safeUrl}: `
      + `${(await page.locator('body').innerText()).slice(0, 1_000)}`,
      { cause: error },
    );
  }
  assert.equal(new URL(page.url()).hash, '', 'The mobile browser retained the QR secret');
  assert.equal(
    (await context.cookies(new URL(link).origin)).some((cookie) => cookie.name === 'device'),
    false,
    'Scanning the QR issued a device credential before local approval',
  );
  assert.equal(
    await page.evaluate(() => fetch('/api/auth/me').then((response) => response.status)),
    401,
    'The pending mobile browser crossed the normal API gate',
  );
  return { context, page };
}

async function main() {
  const repo = path.resolve(process.argv[2] ?? '');
  const cdpUrl = readOption('cdp');
  const remoteOriginOption = readOption('remote-origin');
  if (!repo || !cdpUrl) {
    throw new Error('Usage: pairing-approval-electron.e2e.cjs <repo> --cdp=<url>');
  }

  const { chromium } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const electronBrowser = await chromium.connectOverCDP(cdpUrl);
  let mobileBrowser;
  try {
    const electronPages = electronBrowser.contexts().flatMap((context) => context.pages());
    const electronPage = electronPages.find((page) => /Tessera/i.test(page.url()))
      ?? electronPages[0];
    assert.ok(electronPage, `Electron CDP endpoint has no renderer pages: ${cdpUrl}`);
    await electronPage.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    const rendererTitle = await electronPage.title();
    assert.match(rendererTitle, /Tessera/i);

    const electronUrl = new URL(electronPage.url());
    assert.match(electronUrl.hostname, /^(127\.0\.0\.1|localhost)$/);
    assert.equal(electronUrl.pathname, '/chat');
    assert.notEqual(
      electronUrl.port,
      '32123',
      'Refusing to clear devices or run pairing E2E against the normal Tessera instance',
    );
    const origin = remoteOriginOption
      ? new URL(remoteOriginOption).origin
      : `http://127.0.0.1:${electronUrl.port}`;
    assert.equal(new URL(origin).port, electronUrl.port);
    const clearDevicesStatus = await electronPage.evaluate(() => (
      fetch('/api/devices', { method: 'DELETE' }).then((response) => response.status)
    ));
    assert.equal(clearDevicesStatus, 200, 'Could not reset the isolated test device registry');
    const saveAddressStatus = await electronPage.evaluate((advertisedAddress) => (
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineSettings: { advertisedAddress } }),
      }).then((response) => response.status)
    ), origin);
    assert.equal(saveAddressStatus, 200, 'Could not configure the isolated advertised address');
    await electronPage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await electronPage.waitForURL(/\/chat(?:$|\?)/, { timeout: 30_000 });

    mobileBrowser = await chromium.launch({
      channel: 'msedge',
      headless: true,
      args: ['--no-proxy-server'],
    });

    const approvedMobile = await openMobilePairing(
      mobileBrowser,
      await openPairingApprovalSurface(electronPage, origin),
    );
    const approvedRequest = await waitForPendingRequest(electronPage);
    assert.match(approvedRequest.comparisonCode, /^\d{6}$/);
    assert.match(
      (await approvedMobile.page.getByTestId('pairing-waiting').innerText()).replaceAll(/\s/g, ''),
      new RegExp(approvedRequest.comparisonCode),
    );
    const approveButton = electronPage.getByTestId(`pairing-approve-${approvedRequest.id}`);
    await approveButton.waitFor({ timeout: 20_000 });
    await approveButton.focus();
    await electronPage.keyboard.press('Enter');
    await approvedMobile.page.getByTestId('pairing-approved').waitFor({ timeout: 20_000 });
    await approvedMobile.page.waitForURL(`${origin}/install`, { timeout: 30_000 });
    await approvedMobile.page.getByRole('button', { name: 'Continue in browser' }).click();
    await approvedMobile.page.waitForURL(`${origin}/chat`, { timeout: 30_000 });
    assert.match(
      (await approvedMobile.context.cookies(origin))
        .find((cookie) => cookie.name === 'device')?.value ?? '',
      /^[A-Za-z0-9_-]{43}$/,
    );
    await assertSessionAndWebSocketAccess(approvedMobile.page);
    await approvedMobile.context.close();

    const deniedMobile = await openMobilePairing(
      mobileBrowser,
      await createPairingLink(electronPage, origin),
    );
    const deniedRequest = await waitForPendingRequest(electronPage);
    await electronPage.getByTestId(`pairing-deny-${deniedRequest.id}`).click();
    await deniedMobile.page.getByTestId('pairing-denied').waitFor({ timeout: 20_000 });
    assert.equal(
      (await deniedMobile.context.cookies(origin)).some((cookie) => cookie.name === 'device'),
      false,
    );
    await deniedMobile.context.close();

    const expiringMobile = await openMobilePairing(
      mobileBrowser,
      await createPairingLink(electronPage, origin),
    );
    const expiringRequest = await waitForPendingRequest(electronPage);
    const expiryTimeout = Math.max(
      30_000,
      Date.parse(expiringRequest.expiresAt) - Date.now() + 20_000,
    );
    await expiringMobile.page.getByTestId('pairing-error').waitFor({ timeout: expiryTimeout });
    assert.match(await expiringMobile.page.getByTestId('pairing-error').innerText(), /expired/i);
    assert.equal(
      (await expiringMobile.context.cookies(origin)).some((cookie) => cookie.name === 'device'),
      false,
    );
    await expiringMobile.context.close();

    process.stdout.write(`${JSON.stringify({
      topology: remoteOriginOption
        ? 'packaged-windows-electron-with-mobile-emulated-edge-over-advertised-network'
        : 'packaged-windows-electron-with-mobile-emulated-edge-over-loopback',
      renderer: { title: rendererTitle, origin, pathname: electronUrl.pathname },
      approval: 'passed',
      localApprovalUi: 'passed',
      sessionApiAfterApproval: 'passed',
      websocketAfterApproval: 'passed',
      denial: 'passed',
      naturalExpiry: 'passed',
      deviceCookieBeforeApproval: false,
    }, null, 2)}\n`);
  } finally {
    await mobileBrowser?.close();
    await electronBrowser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
