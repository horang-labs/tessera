// Component browser check: renders production Markdown and lightbox without an app server.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const fixture = await build({
  stdin: {
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { PreviewMarkdown } from './src/components/chat/preview-markdown';
      createRoot(document.getElementById('root')).render(
        <PreviewMarkdown content={'[![Sample](picture.png)](https://example.com)'}
          resolveImageSrc={() => 'https://images.test/sample.png'} variant="document" />
      );`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, write: false, platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (error) => console.error(error));
const screenshots = process.env.TESSERA_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const capture = async (name) => {
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png` });
};
try {
  await page.route('https://images.test/sample.png', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#4682b4"/><text x="40" y="125" fill="white" font-size="30">Markdown image</text></svg>',
  }));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  const opener = page.getByRole('button', { name: 'Sample', exact: true });
  await opener.waitFor();
  await capture('01-markdown-image');
  for (const action of ['click', 'Enter', 'Space']) {
    if (action === 'click') await opener.click();
    else { await opener.focus(); await page.keyboard.press(action); }
    const dialog = page.getByRole('dialog', { name: 'Sample' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('img').getAttribute('src'), 'https://images.test/sample.png');
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
    await dialog.getByRole('button').nth(2).click();
    assert.match(await dialog.innerText(), /125%/);
    await capture(`02-${action}-zoomed`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
    assert.equal(page.url(), 'about:blank');
    assert.equal(page.context().pages().length, 1, 'linked image must not open a browser tab');
    await capture(`03-${action}-closed`);
  }
  console.log('PASS: resolved image URL, click/Enter/Space, zoom, Escape, restored focus, linked-image navigation prevention');
} finally {
  await browser.close();
}
