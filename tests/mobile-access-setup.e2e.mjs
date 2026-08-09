import assert from 'node:assert/strict';

import { startSettingsHarness } from './helpers/settings-dialog-harness.mjs';

const harness = await startSettingsHarness();
let context;
let page;

try {
  ({ context } = await harness.openSettingsPage({ viewport: 'desktop', fontScale: 1 }));
  page = context.pages()[0];
  await page.addInitScript(() => {
    window.__mobileAccessStatus = {
      state: 'tailscale-missing',
      installUrl: 'https://tailscale.com/download',
    };
    window.__mobileAccessExternalUrls = [];
    window.__mobileAccessPolls = 0;
    window.__mobileAccessRemovalAttempts = 0;
    const storage = new Map();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        isElectron: true,
        platform: 'win32',
        getMobileAccessStatus: async () => {
          if (window.__mobileAccessStatus.state === 'authorization-required') {
            window.__mobileAccessPolls += 1;
            if (window.__mobileAccessPolls >= 2) {
              window.__mobileAccessStatus = {
                state: 'ready',
                origin: 'https://desktop.tailnet.ts.net:10443',
              };
            }
          }
          return window.__mobileAccessStatus;
        },
        startMobileAccessSetup: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          window.__mobileAccessStatus = {
            state: 'authorization-required',
            authorizationUrl: 'https://login.tailscale.com/admin/feature/serve',
          };
          return window.__mobileAccessStatus;
        },
        removeMobileAccess: async () => {
          window.__mobileAccessRemovalAttempts += 1;
          if (window.__mobileAccessRemovalAttempts === 1) {
            return { ok: false, error: 'Tailscale Serve off failed' };
          }
          window.__mobileAccessStatus = { state: 'not-configured' };
          return { ok: true, status: window.__mobileAccessStatus };
        },
        openExternalUrl: async (url) => {
          window.__mobileAccessExternalUrls.push(url);
          return { ok: true };
        },
        createPairingCode: async () => ({
          ok: true,
          pairingLink: `https://desktop.tailnet.ts.net/pair#t=${'x'.repeat(43)}`,
          qrDataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }),
        listPairingRequests: async () => ({ ok: true, requests: [] }),
        uiStorageGetItem: (key) => storage.get(key) ?? null,
        uiStorageSetItem: (key, value) => storage.set(key, value),
        uiStorageRemoveItem: (key) => storage.delete(key),
      },
    });
  });

  await page.reload({ waitUntil: 'load' });
  await page.addStyleTag({
    content: 'nextjs-portal { display: none !important; pointer-events: none !important; }',
  });
  await page.evaluate(() => {
    document.querySelectorAll('nextjs-portal').forEach((portal) => portal.remove());
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-nav-remote-access').click();

  const addDevice = page.getByRole('button', { name: 'Add device' });
  await page.getByTestId('mobile-access-status').getByText('Tailscale missing').waitFor();
  assert.equal(await addDevice.isDisabled(), true);
  assert.equal(await page.getByLabel('Advertised address').count(), 0);
  assert.equal(await page.getByText('Windows Firewall').count(), 0);

  await page.getByRole('button', { name: 'Install Tailscale' }).click();
  assert.deepEqual(await page.evaluate(() => window.__mobileAccessExternalUrls), [
    'https://tailscale.com/download',
  ]);

  await page.getByRole('button', { name: 'Retry' }).click();
  await page.getByTestId('mobile-access-status').getByRole('status').getByText('Configuring').waitFor();
  assert.equal(await addDevice.isDisabled(), true);

  await page.getByTestId('mobile-access-status').getByText('Authorization required').waitFor();
  await page.getByRole('button', { name: 'Open authorization' }).click();
  assert.deepEqual(await page.evaluate(() => window.__mobileAccessExternalUrls), [
    'https://tailscale.com/download',
    'https://login.tailscale.com/admin/feature/serve',
  ]);

  await page.getByTestId('mobile-access-status').getByText('Ready').waitFor();
  assert.equal(await addDevice.isEnabled(), true);
  const pushGlobal = page.getByTestId('push-global-enabled');
  assert.equal(await pushGlobal.isChecked(), true);

  await page.getByTestId('mobile-access-remove').click();
  const removalDialog = page.getByTestId('mobile-access-remove-dialog');
  await removalDialog.waitFor();
  await removalDialog.getByText(/Every Paired Device will be disconnected/).waitFor();
  await removalDialog.getByText(/paired again/).waitFor();
  await removalDialog.getByText(/notification permission again/).waitFor();

  await page.screenshot({
    path: '/home/work/tmp/tessera-307-mobile-removal-confirmation.png',
    fullPage: true,
  });

  await page.getByTestId('mobile-access-remove-confirm').click();
  await removalDialog.getByRole('alert').waitFor();
  assert.equal(await addDevice.isEnabled(), true);
  assert.equal(await pushGlobal.isChecked(), true);

  await page.getByTestId('mobile-access-remove-confirm').click();
  await removalDialog.waitFor({ state: 'hidden' });
  await page.getByTestId('mobile-access-status').getByText('Not configured').waitFor();
  assert.equal(await addDevice.isDisabled(), true);
  assert.equal(await pushGlobal.isChecked(), true);

  console.log(JSON.stringify({
    statesVisible: ['Tailscale missing', 'Configuring', 'Authorization required', 'Ready'],
    externalStepsOpened: true,
    addDeviceGatedUntilReady: true,
    removalConfirmationIsDestructive: true,
    removalFailureIsRetryable: true,
    successfulRemovalDisablesPairing: true,
    globalPushSettingUnchanged: true,
    manualAddressControlsAbsent: true,
    firewallAutomationAbsent: true,
  }, null, 2));
} catch (error) {
  console.error(error);
  console.error('Next overlay:', await page?.locator('nextjs-portal').innerText().catch(() => 'none'));
  console.error(harness.logs());
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await harness.stop();
}
