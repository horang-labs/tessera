import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { build } from 'esbuild';
import { launchPhoneBrowser } from './helpers/phone-browser.mjs';
import { createPhoneContext } from './helpers/phone-viewport.mjs';

// Keep the real message-list focus handler and React portal propagation in the
// same browser. A lightbox-only test misses the focus that happens after blur().
const root = path.resolve(import.meta.dirname, '..');
const source = ts.createSourceFile('message-list.tsx', fs.readFileSync(
  path.join(root, 'src/components/chat/message-list.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let clickHandler;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleContentAreaClick') {
    clickHandler = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(clickHandler, 'must use the shipped message-list click handler');
const bundle = await build({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ImageLightbox } from './src/components/chat/image-lightbox';
    function Probe() {
      const [open, setOpen] = useState(false);
      const sessionId = 'focus-probe';
      const selectedToolCallId = null;
      const setSelectedToolCallId = () => {};
      const handleClick = ${clickHandler};
      return <div data-panel-wrapper={location.hash === '#peek' ? undefined : ''}>
        <div data-testid="messages" onClick={handleClick}>
          <button onClick={() => setOpen(true)}>Open image</button>
          <div data-testid="blank">Message blank area</div>
          {open && <ImageLightbox src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='teal'/%3E%3C/svg%3E" onClose={() => { window.closes++; setOpen(false); }} />}
        </div>
        <textarea data-session-input={sessionId} onFocus={() => window.inputFocuses++} />
      </div>;
    }
    window.closes = 0;
    window.inputFocuses = 0;
    createRoot(document.getElementById('root')).render(<Probe />);
  ` },
  bundle: true, write: false, jsx: 'automatic',
  plugins: [{ name: 'presentation-stubs', setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/(i18n|utils|telemetry\/ui-click)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      export const useI18n = () => ({ t: key => key });
      export const cn = (...args) => args.filter(Boolean).join(' ');
      export const telemetryClickAttributes = () => ({});
      export const telemetryIgnoreAttributes = () => ({});
    ` }));
  } }],
});

for (const surface of ['panel', 'peek']) {
  test(`${surface}: closing a portaled image must not refocus the composer`, async () => {
    const browser = await launchPhoneBrowser();
    try {
      const context = await createPhoneContext(browser);
      const page = await context.newPage();
      await page.setContent(`<div id="root"></div><style>
        [role=dialog] { position:fixed; inset:0; background:#ddd; display:flex; align-items:center; justify-content:center }
        [role=dialog]>button { position:absolute; top:10px; right:10px }
        [role=dialog]>div { position:absolute; bottom:20px }
      </style>`);
      await page.evaluate(value => { location.hash = value; }, surface);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      // Positive control: the real parent's blank-area click focuses the input.
      await page.getByTestId('blank').tap();
      assert.equal(await page.evaluate(() => window.inputFocuses), 1);
      for (const close of ['backdrop', 'image', 'button', 'escape']) {
        await page.getByRole('button', { name: 'Open image', exact: true }).tap();
        await page.evaluate(() => { window.inputFocuses = 0; window.closes = 0; });
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        if (close === 'backdrop') await dialog.tap({ position: { x: 10, y: 150 } });
        if (close === 'image') await dialog.locator('img').tap();
        if (close === 'button') await page.getByRole('button', { name: 'common.close', exact: true }).tap();
        if (close === 'escape') await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.inputFocuses), 0, `${close} must not focus the input after closing`);
        assert.equal(await page.evaluate(() => window.closes), 1, `${close} closes exactly once`);
      }
    } finally { await browser.close(); }
  });
}
