import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQuitConfirmation,
  formatRemoteAccessTrayLabel,
  parseRemoteAccessStatus,
  retainLastRemoteAccessStatus,
  resolveElectronLanguage,
  type RemoteAccessStatus,
} from '../electron/remote-access-status';

const enabledStatus: RemoteAccessStatus = {
  registeredDeviceCount: 2,
  connectedDeviceCount: 1,
};

test('device API responses become the registered and connected tray status', () => {
  assert.deepEqual(parseRemoteAccessStatus({
    devices: [
      { id: 'phone', connected: true },
      { id: 'tablet', connected: false },
    ],
  }), enabledStatus);

  assert.equal(parseRemoteAccessStatus({ devices: 'invalid' }), null);
  assert.equal(parseRemoteAccessStatus({ devices: [{ connected: true }] }), null);
});

test('tray status reveals disabled, paired, and currently connected remote access', () => {
  assert.equal(
    formatRemoteAccessTrayLabel('en', {
      registeredDeviceCount: 0,
      connectedDeviceCount: 0,
    }),
    'Remote access: Off',
  );
  assert.equal(
    formatRemoteAccessTrayLabel('en', enabledStatus),
    'Remote access: On · 2 paired · 1 connected',
  );
});

test('quit proceeds without a new prompt when no terminal or remote device is active', () => {
  assert.equal(
    buildQuitConfirmation('en', 0, {
      registeredDeviceCount: 2,
      connectedDeviceCount: 0,
    }),
    null,
  );
});

test('transient polling failures retain the last verified remote status', () => {
  const disconnected: RemoteAccessStatus = {
    registeredDeviceCount: 2,
    connectedDeviceCount: 0,
  };

  assert.deepEqual(retainLastRemoteAccessStatus(disconnected, null), disconnected);
  assert.deepEqual(retainLastRemoteAccessStatus(enabledStatus, null), enabledStatus);
  assert.equal(retainLastRemoteAccessStatus(null, null), null);
});

test('quit confirmation warns when a remote device is currently connected', () => {
  const confirmation = buildQuitConfirmation('en', 0, enabledStatus);

  assert.ok(confirmation);
  assert.equal(confirmation.message, 'Quit while 1 remote device is connected?');
  assert.match(confirmation.detail, /disconnect the remote device/);
  assert.deepEqual(confirmation.buttons, ['Cancel', 'Quit Tessera']);
});

test('terminal warning remains active and combines with remote connection risk', () => {
  const terminalOnly = buildQuitConfirmation('en', 2, {
    registeredDeviceCount: 0,
    connectedDeviceCount: 0,
  });
  assert.ok(terminalOnly);
  assert.equal(terminalOnly.message, 'Quit 2 active terminals?');

  const combined = buildQuitConfirmation('en', 2, enabledStatus);
  assert.ok(combined);
  assert.match(combined.message, /1 remote device/);
  assert.match(combined.detail, /2 active terminals/);
});

test('native Electron messages cover every language supported by Tessera', () => {
  assert.equal(resolveElectronLanguage('ko-KR'), 'ko');
  assert.equal(resolveElectronLanguage('ja-JP'), 'ja');
  assert.equal(resolveElectronLanguage('zh-TW'), 'zh');
  assert.equal(resolveElectronLanguage('fr-FR'), 'en');

  for (const language of ['en', 'ko', 'zh', 'ja'] as const) {
    const label = formatRemoteAccessTrayLabel(language, enabledStatus);
    const confirmation = buildQuitConfirmation(language, 1, enabledStatus);
    assert.ok(label.length > 0);
    assert.ok(confirmation);
    assert.equal(confirmation.buttons.length, 2);
    assert.ok(confirmation.message.length > 0);
    assert.ok(confirmation.detail.length > 0);
  }
});

test('an unavailable remote status fails safe before quit', () => {
  const confirmation = buildQuitConfirmation('en', 0, null);

  assert.ok(confirmation);
  assert.match(confirmation.message, /status is unavailable/i);
});
