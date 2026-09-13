import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function harness(tooltipsEnabled = true) {
  let states = [], cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
      useId: () => 'tooltip',
      cloneElement: (child, props) => ({ ...child, props: { ...child.props, ...props } }),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-dom': { createPortal: node => node },
    '@/hooks/use-tooltips-enabled': { useTooltipsEnabled: () => tooltipsEnabled },
    '@/hooks/use-effective-shortcut': { useEffectiveShortcut: () => null },
    '@/lib/keyboard/format': { formatShortcut: () => '', detectPlatform: () => 'linux' },
    '@/lib/keyboard/conflicts': { isBrowserConflict: () => false },
    '@/hooks/use-electron-platform': { useElectronPlatform: () => null },
    '@/lib/i18n': { useI18n: () => ({ t: key => key }) },
  };
  const source = fs.readFileSync(new URL('../src/components/keyboard/shortcut-tooltip.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: id => modules[id], document: { body: {} } });
  let clicks = 0;
  function render() {
    cursor = 0;
    const result = exports.ShortcutTooltip({ id: 'toggle-terminal-view', label: 'Switch', children: jsx('button', { onClick: () => clicks++ }) });
    return { button: result.props.children[0], tooltip: result.props.children[1] };
  }
  return { render, clicks: () => clicks };
}
const event = (focusVisible = false) => ({ currentTarget: { getBoundingClientRect: () => ({ bottom: 20, left: 0, width: 40 }), matches: () => focusVisible } });

test('activating the view toggle dismisses its tooltip and preserves the action', () => {
  const h = harness();
  h.render().button.props.onMouseEnter(event());
  assert.ok(h.render().tooltip);
  h.render().button.props.onClick(event());
  assert.equal(h.render().tooltip, null);
  assert.equal(h.clicks(), 1);
});

test('touch focus does not leave a tooltip open; keyboard focus still shows it', () => {
  const h = harness();
  h.render().button.props.onFocus(event(false));
  assert.equal(h.render().tooltip, null);
  h.render().button.props.onFocus(event(true));
  assert.ok(h.render().tooltip);
  h.render().button.props.onBlur(event());
  assert.equal(h.render().tooltip, null);
});

test('mobile suppresses tooltips on both hover and keyboard focus without blocking clicks', () => {
  const h = harness(false);
  h.render().button.props.onMouseEnter(event());
  h.render().button.props.onFocus(event(true));
  assert.equal(h.render().tooltip, null);
  assert.equal(h.render().button.props['aria-describedby'], undefined);
  h.render().button.props.onClick(event());
  assert.equal(h.clicks(), 1);
});
