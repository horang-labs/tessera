import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemStatusIndicator } from '../src/components/chat/work-item-primitives.tsx';
import {
  FONT_SCALE_OPTIONS,
  normalizeFontScale,
} from '../src/lib/settings/provider-defaults.ts';

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
  assert.match(renderStatusIndicator({ isAwaitingUser: true }), /h-\[10px\].*w-\[10px\]/);
  assert.match(renderStatusIndicator({ hasUnread: true }), /h-\[9px\].*w-\[9px\]/);
  assert.match(renderStatusIndicator({ isProcessing: true }), /h-\[10px\].*w-\[10px\]/);
  assert.match(renderStatusIndicator({ isRunning: true }), /h-\[8px\].*w-\[8px\]/);
  assert.match(renderStatusIndicator({ isRunning: true }), /-top-1 -left-1/);
});

test('board and non-corner status indicators keep their original sizing', () => {
  const boardSpinner = renderStatusIndicator({ isProcessing: true, surface: 'board' });
  const leadingSpinner = renderStatusIndicator({ isProcessing: true, placement: 'leading' });

  assert.match(boardSpinner, /h-\[7px\].*w-\[7px\]/);
  assert.match(boardSpinner, /-top-0\.5 -left-0\.5/);
  assert.doesNotMatch(boardSpinner, /h-\[10px\]/);
  assert.match(leadingSpinner, /h-\[7px\].*w-\[7px\]/);
  assert.doesNotMatch(leadingSpinner, /h-\[10px\]/);
});
