import assert from 'node:assert/strict';
import test from 'node:test';
import { isLinuxWaylandSession } from '../src/lib/terminal/linux-wayland-rendering';

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
