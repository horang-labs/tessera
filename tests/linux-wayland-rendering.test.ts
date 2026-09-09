import assert from 'node:assert/strict';
import test from 'node:test';
import { isLinuxWaylandSession, linuxWaylandImeSwitches } from '../src/lib/terminal/linux-wayland-rendering';

test('detects a Linux Wayland session from the native environment', () => {
  assert.equal(isLinuxWaylandSession({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
  }), true);
});

test('honors an explicit X11 Ozone override on a Wayland desktop', () => {
  assert.equal(isLinuxWaylandSession({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    ozonePlatform: 'x11',
  }), false);
});

test('does not apply the policy outside Linux', () => {
  assert.equal(isLinuxWaylandSession({
    platform: 'win32',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
  }), false);
});

test('selects native Wayland IME with text-input-v3 on a Wayland desktop', () => {
  assert.deepEqual(linuxWaylandImeSwitches({
    platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' },
  }), [
    ['ozone-platform', 'wayland'], ['enable-wayland-ime', ''], ['wayland-text-input-version', '3'],
  ]);
});

test('leaves X11 desktops, explicit X11 overrides, and other operating systems unchanged', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    assert.deepEqual(linuxWaylandImeSwitches({ platform, env: {} }), []);
    assert.deepEqual(linuxWaylandImeSwitches({
      platform, env: { WAYLAND_DISPLAY: 'wayland-0' }, ozonePlatform: 'x11',
    }), []);
  }
  assert.deepEqual(linuxWaylandImeSwitches({
    platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
  }), []);
});

test('honors an explicit native backend over an X11 environment hint', () => {
  assert.ok(linuxWaylandImeSwitches({
    platform: 'linux', env: { ELECTRON_OZONE_PLATFORM_HINT: 'x11' }, ozonePlatform: 'wayland',
  }).length > 0);
});

test('does not replace an explicitly selected unrelated backend', () => {
  assert.deepEqual(linuxWaylandImeSwitches({
    platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, ozonePlatform: 'headless',
  }), []);
});

test('Wayland environment variables do not activate the policy on macOS or Windows', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    assert.deepEqual(linuxWaylandImeSwitches({
      platform, env: { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
    }), []);
  }
});
