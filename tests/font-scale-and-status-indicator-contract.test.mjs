import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as workItemPrimitives from '../src/components/chat/work-item-primitives.tsx';
import * as providerDefaults from '../src/lib/settings/provider-defaults.ts';

const { ItemStatusIndicator } = workItemPrimitives.default ?? workItemPrimitives;
const { FONT_SCALE_OPTIONS, normalizeFontScale } = providerDefaults.default ?? providerDefaults;

const settingsDefaultsSource = fs.readFileSync(
  new URL('../src/lib/settings/provider-defaults.ts', import.meta.url),
  'utf8',
);
const layoutSource = fs.readFileSync(
  new URL('../src/app/layout.tsx', import.meta.url),
  'utf8',
);
test('font scale presets keep the default and provide a substantially larger maximum', () => {
  const expectedScales = /\[0\.8125, 0\.875, 1, 1\.25\]/;

  assert.deepEqual(FONT_SCALE_OPTIONS, [0.8125, 0.875, 1, 1.25]);
  assert.match(settingsDefaultsSource, expectedScales);
  assert.match(layoutSource, expectedScales);
  assert.match(settingsDefaultsSource, /DEFAULT_FONT_SCALE = 0\.875/);
});

test('legacy large font scale upgrades without shrinking', () => {
  assert.equal(normalizeFontScale(0.9375), 1);
  assert.equal(normalizeFontScale(0.875), 0.875);
  assert.equal(normalizeFontScale(1.25), 1.25);
  assert.match(layoutSource, /if \(raw === 0\.9375\) raw = 1/);
});

function renderStatusIndicator({
  hasUnread = false,
  isAwaitingUser = false,
  isProcessing = false,
  isRunning = false,
  placement = 'corner',
  surface = 'sidebar',
} = {}) {
  return renderToStaticMarkup(createElement(ItemStatusIndicator, {
    hasUnread,
    isAwaitingUser,
    isProcessing,
    isRunning,
    placement,
    surface,
  }));
}

test('sidebar corner status indicators render enlarged sizes and offset', () => {
  const awaiting = renderStatusIndicator({ isAwaitingUser: true });
  const unread = renderStatusIndicator({ hasUnread: true });
  const processing = renderStatusIndicator({ isProcessing: true });
  const running = renderStatusIndicator({ isRunning: true });

  assert.match(awaiting, /h-\[0\.75rem\].*w-\[0\.75rem\]/);
  assert.match(unread, /h-\[0\.6875rem\].*w-\[0\.6875rem\]/);
  assert.match(processing, /h-\[0\.75rem\].*w-\[0\.75rem\]/);
  assert.match(running, /h-\[0\.625rem\].*w-\[0\.625rem\]/);
  assert.match(renderStatusIndicator({ isRunning: true }), /-top-1 -left-1/);

  for (const rootFontSize of [16, 20]) {
    const expectedSpinnerSize = rootFontSize === 16 ? 12 : 15;
    assert.equal(0.75 * rootFontSize, expectedSpinnerSize);
  }
});

test('board and non-corner status indicators keep their original sizing', () => {
  const statusCases = [
    [{ isAwaitingUser: true }, 7],
    [{ hasUnread: true }, 6],
    [{ isProcessing: true }, 7],
    [{ isRunning: true }, 5],
  ];

  for (const [status, expectedSize] of statusCases) {
    const boardCorner = renderStatusIndicator({ ...status, surface: 'board' });
    assert.match(boardCorner, new RegExp(`h-\\[${expectedSize}px\\].*w-\\[${expectedSize}px\\]`));
    assert.match(boardCorner, /-top-0\.5 -left-0\.5/);
    assert.doesNotMatch(boardCorner, /h-\[[0-9.]+rem\]/);

    for (const placement of ['leading', 'inline']) {
      for (const surface of ['sidebar', 'board']) {
        const nonCorner = renderStatusIndicator({ ...status, placement, surface });
        assert.match(nonCorner, new RegExp(`h-\\[${expectedSize}px\\].*w-\\[${expectedSize}px\\]`));
        assert.doesNotMatch(nonCorner, /h-\[[0-9.]+rem\]/);
      }
    }
  }
});
