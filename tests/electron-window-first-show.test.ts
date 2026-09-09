import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { onWindowFirstShow } from '../electron/window-first-show';

function fixture(nativeWayland: boolean) {
  const win = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  let shown = 0;
  onWindowFirstShow(win, nativeWayland, () => { shown++; });
  return { win, shown: () => shown };
}

test('Wayland reveals a loaded window even when the compositor defers its first frame', () => {
  const { win, shown } = fixture(true);
  win.webContents.emit('did-finish-load');
  assert.equal(shown(), 1);
  win.emit('ready-to-show');
  win.webContents.emit('did-finish-load');
  assert.equal(shown(), 1);
});

test('ready-to-show still reveals Wayland windows first when available', () => {
  const { win, shown } = fixture(true);
  win.emit('ready-to-show');
  assert.equal(shown(), 1);
  assert.equal(win.webContents.listenerCount('did-finish-load'), 0);
});

test('other backends wait for the first frame', () => {
  const { win, shown } = fixture(false);
  win.webContents.emit('did-finish-load');
  assert.equal(shown(), 0);
  win.emit('ready-to-show');
  assert.equal(shown(), 1);
});

test('closing a window cancels its pending reveal', () => {
  const { win, shown } = fixture(true);
  win.emit('closed');
  win.webContents.emit('did-finish-load');
  win.emit('ready-to-show');
  assert.equal(shown(), 0);
});
