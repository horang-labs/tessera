import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';

// Exercise the component's pointer handlers with persistent React hook state.
function mountLightbox() {
  const slots = [];
  let cursor = 0;
  let closes = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback: fn => fn,
    useEffect: () => {},
  };
  const source = fs.readFileSync(new URL('../src/components/chat/image-lightbox.tsx', import.meta.url), 'utf8');
  const context = { module: { exports: {} }, document: { body: {} }, HTMLElement: class {}, React: react,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react-dom') return { createPortal: node => node };
      if (name === 'lucide-react') return {};
      if (name.endsWith('ui-click')) return { telemetryClickAttributes: () => ({}), telemetryIgnoreAttributes: () => ({}) };
      if (name.endsWith('use-close-on-escape')) return { useCloseOnEscape() {} };
      if (name.endsWith('use-electron-platform')) return { useElectronPlatform: () => null };
      if (name.endsWith('i18n')) return { useI18n: () => ({ t: key => key }) };
      if (name.endsWith('utils')) return { cn: (...items) => items.join(' ') };
      throw new Error(name);
    },
  };
  vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code, context);
  return { render() { cursor = 0; return context.module.exports.ImageLightbox({ src: 'test.png', onClose: () => closes++ }); }, get closes() { return closes; } };
}
function descendants(node) {
  return [node, ...(node.children ?? []).flat().filter(value => value && typeof value === 'object').flatMap(descendants)];
}
function button(tree, label) { return descendants(tree).find(node => node.props['aria-label'] === label); }
const surface = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
const pointer = (x, y, button = 0) => ({ pointerId: 1, pointerType: 'mouse', button, clientX: x, clientY: y, currentTarget: surface, preventDefault() {} });

test('zoomed image moves with left drag, stays open on release, and reset recenters', () => {
  const app = mountLightbox();
  button(app.render(), 'chat.imageZoomIn').props.onClick();
  let tree = app.render();
  let img = descendants(tree).find(node => node.type === 'img');
  assert.equal(typeof img.props.onPointerDown, 'function');
  img.props.onPointerDown(pointer(100, 100));
  img.props.onPointerMove(pointer(180, 140));
  img.props.onPointerUp(pointer(180, 140));
  tree = app.render();
  img = descendants(tree).find(node => node.type === 'img');
  assert.match(img.props.style.transform, /translate\(80px, 40px\)/);
  tree.props.onClick();
  assert.equal(app.closes, 0);
  button(tree, 'chat.imageZoomReset').props.onClick();
  img = descendants(app.render()).find(node => node.type === 'img');
  assert.match(img.props.style.transform, /translate\(0px, 0px\) scale\(1\)/);
  app.render().props.onClick();
  assert.equal(app.closes, 1);
});

test('right button does not pan and cancelled drags stop tracking', () => {
  const app = mountLightbox();
  let img = descendants(app.render()).find(node => node.type === 'img');
  img.props.onPointerDown(pointer(100, 100, 2));
  img.props.onPointerMove(pointer(180, 140));
  assert.match(descendants(app.render()).find(node => node.type === 'img').props.style.transform, /translate\(0px, 0px\)/);
  img.props.onPointerDown(pointer(100, 100));
  img.props.onPointerMove(pointer(180, 140));
  img.props.onPointerCancel(pointer(180, 140));
  img.props.onPointerMove(pointer(250, 200));
  img = descendants(app.render()).find(node => node.type === 'img');
  assert.match(img.props.style.transform, /translate\(80px, 40px\)/);
  const tree = app.render();
  tree.props.onPointerDownCapture();
  tree.props.onClick();
  assert.equal(app.closes, 1);
});
