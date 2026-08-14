import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const cdpUrl = process.env.TESSERA_E2E_CDP_URL;
if (!cdpUrl) {
  throw new Error('TESSERA_E2E_CDP_URL is required');
}

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context?.pages()[0];
if (!page) throw new Error('Electron CDP connection has no renderer page');

try {
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
  await page.getByTestId('tab-bar').waitFor({ state: 'visible', timeout: 30_000 });

  const measurements = await page.evaluate(async () => {
    const tabItems = document.querySelector('[data-testid="tab-bar-items"]');
    const sampleTab = tabItems?.querySelector('[data-testid="tab-item"]');
    if (!(tabItems instanceof HTMLElement) || !(sampleTab instanceof HTMLElement)) {
      throw new Error('Tab bar does not contain a clonable tab item');
    }

    // Reproduce a crowded tab strip without mutating the persisted test profile.
    while (tabItems.querySelectorAll('[data-testid="tab-item"]').length < 24) {
      tabItems.append(sampleTab.cloneNode(true));
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const measure = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const pointX = rect.left + rect.width / 2;
      const pointY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(pointX, pointY);
      return {
        width: rect.width,
        height: rect.height,
        appRegion: getComputedStyle(element).webkitAppRegion,
        hitTestId: hit instanceof HTMLElement ? hit.dataset.testid ?? null : null,
        hitClassName: hit instanceof HTMLElement ? hit.className : null,
      };
    };

    return {
      tabCount: tabItems.querySelectorAll('[data-testid="tab-item"]').length,
      tabBar: measure('tab-bar'),
      tabDragLane: measure('tab-bar-new-tab-drop-zone'),
    };
  });

  process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);
  assert.equal(measurements.tabCount, 24);
  assert.equal(measurements.tabDragLane?.appRegion, 'drag');
  assert.equal(measurements.tabDragLane?.hitTestId, 'tab-bar-new-tab-drop-zone');
  assert.ok(
    (measurements.tabDragLane?.width ?? 0) >= 48,
    `crowded tabs must leave at least a 48px draggable lane: ${JSON.stringify(measurements)}`,
  );
} finally {
  await browser.close();
}
