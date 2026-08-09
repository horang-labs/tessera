import assert from 'node:assert/strict';

import { startSettingsHarness } from './helpers/settings-dialog-harness.mjs';

const harness = await startSettingsHarness();
let context;

try {
  ({ context } = await harness.openSettingsPage({ viewport: 'desktop', fontScale: 1 }));
  const page = context.pages()[0];
  await page.addInitScript(() => {
    window.__mobileAccessStatus = { state: 'not-configured' };
    const storage = new Map();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        isElectron: true,
        platform: 'win32',
        supportsTailscaleFirewallConfiguration: false,
        getRemoteAccessAddressCandidates: async () => [],
        getMobileAccessStatus: async () => window.__mobileAccessStatus,
        startMobileAccessSetup: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          window.__mobileAccessStatus = {
            state: 'ready',
            origin: 'https://desktop.tailnet.ts.net',
          };
          return window.__mobileAccessStatus;
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
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-nav-remote-access').click();

  const addDevice = page.getByRole('button', { name: 'Add device' });
  await page.getByTestId('mobile-access-status').getByText('Not configured').waitFor();
  assert.equal(await addDevice.isDisabled(), true);
  await page.getByLabel('Advertised address').waitFor();

  await page.getByRole('button', { name: 'Set up mobile access' }).click();
  await page.getByTestId('mobile-access-status').getByText('Configuring').waitFor();
  assert.equal(await addDevice.isDisabled(), true);

  await page.getByTestId('mobile-access-status').getByText('Ready').waitFor();
  assert.equal(await addDevice.isEnabled(), true);

  await page.screenshot({
    path: '/home/work/tmp/tessera-298-mobile-access-ready.png',
    fullPage: true,
  });
  await addDevice.click();
  await page.getByText('https://desktop.tailnet.ts.net/pair#t=').waitFor();

  console.log(JSON.stringify({
    statesVisible: ['Not configured', 'Configuring', 'Ready'],
    addDeviceGatedUntilReady: true,
    pairingUsesServeOrigin: true,
    manualAddressStillReachable: true,
  }, null, 2));
} catch (error) {
  console.error(error);
  console.error(harness.logs());
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  await harness.stop();
}
