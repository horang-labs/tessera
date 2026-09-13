import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreWorkspaceFileScroll } from '../src/lib/workspace-files/workspace-file-scroll';

test('restores after lazy loading, saves each session, and respects user scrolling', (t) => {
  let resize = () => {};
  let disconnected = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  } });
  class Viewport extends EventTarget {
    clientHeight = 100;
    firstElementChild = {};
    maxTop = 100;
    top = 0;
    get scrollTop() { return this.top; }
    set scrollTop(value: number) { this.top = Math.min(value, this.maxTop); }
  }
  const viewport = new Viewport();
  let saved = 0;
  const attach = (top: number) => restoreWorkspaceFileScroll(
    viewport as unknown as HTMLDivElement, top, (value) => { saved = value; },
  );
  let cleanup = attach(700);
  assert.equal(viewport.scrollTop, 100);
  viewport.dispatchEvent(new Event('scroll'));
  cleanup();
  assert.equal(saved, 700, 'leaving before loading finishes preserves the target');
  assert.equal(disconnected, true);

  cleanup = attach(saved);
  viewport.maxTop = 1000;
  resize();
  assert.equal(viewport.scrollTop, 700);
  viewport.scrollTop = 450;
  cleanup();
  assert.equal(saved, 450, 'captures scrolling even before the scroll event');

  viewport.maxTop = 100;
  cleanup = attach(700);
  viewport.dispatchEvent(new Event('wheel'));
  viewport.scrollTop = 40;
  viewport.maxTop = 1000;
  resize();
  assert.equal(viewport.scrollTop, 40, 'loading must not override user input');
  cleanup();
  assert.equal(saved, 40);
});
