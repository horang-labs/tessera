import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTerminalTheme,
  getTerminalThemePresets,
} from '@/lib/terminal/terminal-theme';

test('terminal offers four curated presets for each appearance mode', () => {
  assert.deepEqual(
    getTerminalThemePresets('light').map(({ id, nameKey }) => ({ id, nameKey })),
    [
      { id: 'lifted-neutral', nameKey: 'settings.terminalTheme.presets.liftedNeutral' },
      { id: 'cool-porcelain', nameKey: 'settings.terminalTheme.presets.coolPorcelain' },
      { id: 'blue-frost', nameKey: 'settings.terminalTheme.presets.blueFrost' },
      { id: 'pure-white', nameKey: 'settings.terminalTheme.presets.pureWhite' },
    ],
  );
  assert.deepEqual(
    getTerminalThemePresets('dark').map(({ id, nameKey }) => ({ id, nameKey })),
    [
      { id: 'neutral-charcoal', nameKey: 'settings.terminalTheme.presets.neutralCharcoal' },
      { id: 'graphite-blue', nameKey: 'settings.terminalTheme.presets.graphiteBlue' },
      { id: 'deep-navy', nameKey: 'settings.terminalTheme.presets.deepNavy' },
      { id: 'soft-slate', nameKey: 'settings.terminalTheme.presets.softSlate' },
    ],
  );
});

test('every terminal preset provides a complete hexadecimal xterm palette', () => {
  const requiredColors = [
    'background', 'foreground', 'cursor', 'cursorAccent',
    'selectionBackground', 'selectionForeground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ] as const;

  for (const mode of ['light', 'dark'] as const) {
    for (const preset of getTerminalThemePresets(mode)) {
      for (const color of requiredColors) {
        assert.match(
          preset.theme[color] ?? '',
          /^#[0-9a-f]{6}$/i,
          `${preset.id}.${color} must be a six-digit hex color`,
        );
      }
    }
  }
});

test('terminal resolves a selected preset and rejects one from the opposite mode', () => {
  assert.equal(getTerminalTheme(false, 'blue-frost').background, '#f3f7fb');
  assert.equal(getTerminalTheme(true, 'graphite-blue').background, '#111820');
  assert.equal(getTerminalTheme(false, 'graphite-blue').background, '#fafaf9');
  assert.equal(getTerminalTheme(true, 'unknown-preset' as never).background, '#161616');
});

test('terminal exposes the approved Lifted Neutral light palette', () => {
  assert.deepEqual(getTerminalTheme(false), {
    overviewRulerBorder: 'transparent',
    scrollbarSliderBackground: 'rgba(121, 121, 121, 0.4)',
    scrollbarSliderHoverBackground: 'rgba(121, 121, 121, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(121, 121, 121, 0.8)',
    background: '#fafaf9',
    foreground: '#25282b',
    cursor: '#25282b',
    cursorAccent: '#fafaf9',
    selectionBackground: '#accef7',
    selectionForeground: '#25282b',
    black: '#ecece8',
    red: '#b83232',
    green: '#4b821f',
    yellow: '#806b00',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#05727e',
    white: '#6a6a6a',
    brightBlack: '#555753',
    brightRed: '#d44747',
    brightGreen: '#2f702c',
    brightYellow: '#695900',
    brightBlue: '#204a87',
    brightMagenta: '#976a92',
    brightCyan: '#034b50',
    brightWhite: '#3d3d3d',
  });
});

test('terminal exposes the approved Neutral Charcoal dark palette', () => {
  assert.deepEqual(getTerminalTheme(true), {
    overviewRulerBorder: 'transparent',
    scrollbarSliderBackground: 'rgba(180, 180, 185, 0.4)',
    scrollbarSliderHoverBackground: 'rgba(180, 180, 185, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(180, 180, 185, 0.8)',
    background: '#161616',
    foreground: '#e3e9ed',
    cursor: '#e4edf2',
    cursorAccent: '#161616',
    selectionBackground: '#303030',
    selectionForeground: '#f4f8fa',
    black: '#141a1f',
    red: '#df797c',
    green: '#91c497',
    yellow: '#d7bc70',
    blue: '#80afd0',
    magenta: '#b5a0c8',
    cyan: '#72b9c1',
    white: '#c9d1d7',
    brightBlack: '#71818d',
    brightRed: '#ee898c',
    brightGreen: '#a1d4a7',
    brightYellow: '#e6cb80',
    brightBlue: '#90c0e1',
    brightMagenta: '#c6b0d9',
    brightCyan: '#82cad2',
    brightWhite: '#f3f7f9',
  });
});
