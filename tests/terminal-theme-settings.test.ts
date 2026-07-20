import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

test('terminal theme preset settings default to the existing approved palettes', () => {
  const settings = normalizeUserSettings({});
  assert.equal(settings.terminalThemeLightPreset, 'lifted-neutral');
  assert.equal(settings.terminalThemeDarkPreset, 'neutral-charcoal');
});

test('terminal theme preset settings preserve valid mode-specific selections', () => {
  const settings = normalizeUserSettings({
    terminalThemeLightPreset: 'cool-porcelain',
    terminalThemeDarkPreset: 'graphite-blue',
  });
  assert.equal(settings.terminalThemeLightPreset, 'cool-porcelain');
  assert.equal(settings.terminalThemeDarkPreset, 'graphite-blue');
});

test('terminal theme preset settings reject unknown and opposite-mode selections', () => {
  const settings = normalizeUserSettings({
    terminalThemeLightPreset: 'deep-navy',
    terminalThemeDarkPreset: 'not-a-theme',
  } as unknown as Parameters<typeof normalizeUserSettings>[0]);
  assert.equal(settings.terminalThemeLightPreset, 'lifted-neutral');
  assert.equal(settings.terminalThemeDarkPreset, 'neutral-charcoal');
});
