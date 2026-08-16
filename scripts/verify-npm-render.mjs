import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const targetUrl = process.argv[2];

if (!targetUrl) {
  throw new Error('Usage: node scripts/verify-npm-render.mjs <url>');
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const runtimeErrors = [];

  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  const response = await page.goto(targetUrl, {
    waitUntil: 'load',
    timeout: 120_000,
  });

  assert.ok(response, 'the browser did not receive a document response');
  assert.equal(response.status(), 200, `rendered page returned HTTP ${response.status()}`);

  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1_000);

  const rendered = await page.evaluate(() => ({
    bodyTextLength: document.body.innerText.trim().length,
    hasNextRuntime: Boolean(document.querySelector('script[src*="/_next/static/"]')),
  }));

  assert.ok(rendered.bodyTextLength > 0, 'rendered page body is empty');
  assert.ok(rendered.hasNextRuntime, 'rendered page did not load the Next.js runtime');
  assert.deepEqual(runtimeErrors, [], `browser runtime errors:\n${runtimeErrors.join('\n')}`);

  console.log(
    `Rendered ${page.url()} successfully (${rendered.bodyTextLength} visible characters)`,
  );
} finally {
  await browser.close();
}
