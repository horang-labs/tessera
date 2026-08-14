import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const cdpUrl = process.env.TESSERA_E2E_CDP_URL;
const electronProcessId = process.env.TESSERA_E2E_PROCESS_ID;
if (!cdpUrl) {
  throw new Error('TESSERA_E2E_CDP_URL is required');
}

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context?.pages()[0];
if (!page) throw new Error('Electron CDP connection has no renderer page');
let originalTabScrollLeft = 0;

try {
  // A prior interrupted run may have left synthetic tabs in this renderer.
  // Reload first so the assertion always starts from React-owned DOM.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
  await page.getByTestId('tab-bar').waitFor({ state: 'visible', timeout: 30_000 });
  originalTabScrollLeft = await page
    .getByTestId('tab-bar-items')
    .evaluate((tabItems) => tabItems.scrollLeft);

  const measurements = await page.evaluate(async () => {
    const tabItems = document.querySelector('[data-testid="tab-bar-items"]');
    const sampleTab = tabItems?.querySelector('[data-testid="tab-item"]');
    if (!(tabItems instanceof HTMLElement) || !(sampleTab instanceof HTMLElement)) {
      throw new Error('Tab bar does not contain a clonable tab item');
    }

    // Reproduce a crowded tab strip without mutating the persisted test profile.
    while (tabItems.querySelectorAll('[data-testid="tab-item"]').length < 24) {
      const clone = sampleTab.cloneNode(true);
      clone.dataset.e2eSyntheticTab = 'true';
      tabItems.append(clone);
    }

    // Put several no-drag tab nodes outside their scroll viewport. Chromium's
    // draggable-region calculation does not honor the visual overflow clip, so
    // item-owned no-drag rectangles would otherwise subtract the AppHeader.
    tabItems.scrollLeft = tabItems.scrollWidth;

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const measure = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const pointX = rect.left + rect.width / 2;
      const pointY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(pointX, pointY);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        centerX: pointX,
        centerY: pointY,
        appRegion: getComputedStyle(element).webkitAppRegion,
        hitTestId: hit instanceof HTMLElement ? hit.dataset.testid ?? null : null,
        hitClassName: hit instanceof HTMLElement ? hit.className : null,
      };
    };

    const appHeader = document.querySelector('[data-testid="app-header"]');
    const appHeaderRect = appHeader?.getBoundingClientRect();
    const offscreenNoDragTabsOverlappingHeader = appHeaderRect
      ? [...tabItems.querySelectorAll('[data-testid="tab-item"]')].filter((tab) => {
          const rect = tab.getBoundingClientRect();
          return (
            getComputedStyle(tab).webkitAppRegion === 'no-drag' &&
            rect.left < appHeaderRect.right &&
            rect.right > appHeaderRect.left
          );
        }).length
      : -1;

    return {
      devicePixelRatio: window.devicePixelRatio,
      tabCount: tabItems.querySelectorAll('[data-testid="tab-item"]').length,
      tabBar: measure('tab-bar'),
      tabBarItems: measure('tab-bar-items'),
      appHeaderDragLane: measure('app-header-drag-lane'),
      tabDragLane: measure('tab-bar-new-tab-drop-zone'),
      offscreenNoDragTabsOverlappingHeader,
    };
  });

  process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);
  assert.equal(measurements.tabCount, 24);
  assert.equal(measurements.tabBarItems?.appRegion, 'no-drag');
  assert.equal(measurements.offscreenNoDragTabsOverlappingHeader, 0);
  assert.equal(measurements.appHeaderDragLane?.hitTestId, 'app-header-drag-surface');
  assert.ok(
    (measurements.appHeaderDragLane?.width ?? 0) >= 48,
    `project header must leave at least a 48px draggable lane: ${JSON.stringify(measurements)}`,
  );
  assert.ok(
    (measurements.appHeaderDragLane?.height ?? 0) >= 39,
    `project header drag lane must fill the titlebar height: ${JSON.stringify(measurements)}`,
  );
  assert.equal(measurements.tabDragLane?.appRegion, 'drag');
  assert.equal(measurements.tabDragLane?.hitTestId, 'tab-bar-new-tab-drop-zone');
  assert.ok(
    (measurements.tabDragLane?.width ?? 0) >= 48,
    `crowded tabs must leave at least a 48px draggable lane: ${JSON.stringify(measurements)}`,
  );

  if (electronProcessId) {
    const hitTestScript = fileURLToPath(
      new URL('./helpers/windows-native-hit-test.ps1', import.meta.url),
    );
    const nativeHitAt = (measurement) => {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          hitTestScript,
          '-ProcessId',
          electronProcessId,
          '-ClientX',
          String(Math.round(measurement.centerX * measurements.devicePixelRatio)),
          '-ClientY',
          String(Math.round(measurement.centerY * measurements.devicePixelRatio)),
        ],
        { encoding: 'utf8' },
      );
      const result = JSON.parse(output);
      return Array.isArray(result.points) ? result.points[0] : result.points;
    };

    const appHeaderNativeHit = nativeHitAt(measurements.appHeaderDragLane);
    const tabLaneNativeHit = nativeHitAt(measurements.tabDragLane);
    process.stdout.write(
      `${JSON.stringify({ appHeaderNativeHit, tabLaneNativeHit }, null, 2)}\n`,
    );
    assert.equal(
      appHeaderNativeHit.hit,
      2,
      `crowded tabs must not subtract the native AppHeader caption region: ${JSON.stringify(appHeaderNativeHit)}`,
    );
    assert.equal(tabLaneNativeHit.hit, 2);
  }
} finally {
  if (!page.isClosed()) {
    await page
      .locator('[data-e2e-synthetic-tab="true"]')
      .evaluateAll((tabs) => tabs.forEach((tab) => tab.remove()))
      .catch(() => {});
    await page
      .getByTestId('tab-bar-items')
      .evaluate((tabItems, scrollLeft) => {
        tabItems.scrollLeft = scrollLeft;
      }, originalTabScrollLeft)
      .catch(() => {});
  }
  await browser.close();
}
