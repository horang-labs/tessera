import type { ITheme } from '@xterm/xterm';

export type TesseraTerminalTheme = ITheme & {
  background: string;
  foreground: string;
};

export type TerminalLightThemePresetId =
  | 'lifted-neutral'
  | 'cool-porcelain'
  | 'blue-frost'
  | 'pure-white';

export type TerminalDarkThemePresetId =
  | 'neutral-charcoal'
  | 'graphite-blue'
  | 'deep-navy'
  | 'soft-slate';

export type TerminalThemePresetId = TerminalLightThemePresetId | TerminalDarkThemePresetId;
export type TerminalThemePresetMode = 'light' | 'dark';
export type TerminalThemePresetNameKey =
  | 'settings.terminalTheme.presets.liftedNeutral'
  | 'settings.terminalTheme.presets.coolPorcelain'
  | 'settings.terminalTheme.presets.blueFrost'
  | 'settings.terminalTheme.presets.pureWhite'
  | 'settings.terminalTheme.presets.neutralCharcoal'
  | 'settings.terminalTheme.presets.graphiteBlue'
  | 'settings.terminalTheme.presets.deepNavy'
  | 'settings.terminalTheme.presets.softSlate';

export interface TerminalThemePreset {
  id: TerminalThemePresetId;
  nameKey: TerminalThemePresetNameKey;
  mode: TerminalThemePresetMode;
  theme: TesseraTerminalTheme;
}

// xterm 6 renders its own scrollbar. Keep it a neutral overlay independent of
// each preset's accent colors so every preset gets a persistent, visible slider.
type ScrollbarChrome = Pick<
  TesseraTerminalTheme,
  | 'overviewRulerBorder'
  | 'scrollbarSliderBackground'
  | 'scrollbarSliderHoverBackground'
  | 'scrollbarSliderActiveBackground'
>;

const LIGHT_SCROLLBAR_CHROME: ScrollbarChrome = {
  overviewRulerBorder: 'transparent',
  scrollbarSliderBackground: 'rgba(121, 121, 121, 0.4)',
  scrollbarSliderHoverBackground: 'rgba(121, 121, 121, 0.6)',
  scrollbarSliderActiveBackground: 'rgba(121, 121, 121, 0.8)',
};

const DARK_SCROLLBAR_CHROME: ScrollbarChrome = {
  overviewRulerBorder: 'transparent',
  scrollbarSliderBackground: 'rgba(180, 180, 185, 0.4)',
  scrollbarSliderHoverBackground: 'rgba(180, 180, 185, 0.6)',
  scrollbarSliderActiveBackground: 'rgba(180, 180, 185, 0.8)',
};

// Lifted Neutral remains the light default so existing users keep the approved palette.
export const TERMINAL_LIGHT_THEME: TesseraTerminalTheme = {
  ...LIGHT_SCROLLBAR_CHROME,
  background: '#fafaf9',
  foreground: '#25282b',
  cursor: '#25282b',
  cursorAccent: '#fafaf9',
  selectionBackground: '#accef7',
  selectionForeground: '#25282b',
  // Codex and Claude use ANSI black as a full-width user-message background.
  // A light neutral keeps that surface distinct without producing a dark,
  // high-contrast slab inside Tessera's light theme. xterm's contrast policy
  // still darkens this slot automatically when an app uses it as foreground.
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
};

// Neutral Charcoal remains the dark default and Tessera's most neutral PTY surface.
export const TERMINAL_DARK_THEME: TesseraTerminalTheme = {
  ...DARK_SCROLLBAR_CHROME,
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
};

const LIGHT_PRESETS: readonly TerminalThemePreset[] = [
  {
    id: 'lifted-neutral',
    nameKey: 'settings.terminalTheme.presets.liftedNeutral',
    mode: 'light',
    theme: TERMINAL_LIGHT_THEME,
  },
  {
    id: 'cool-porcelain',
    nameKey: 'settings.terminalTheme.presets.coolPorcelain',
    mode: 'light',
    theme: {
      ...LIGHT_SCROLLBAR_CHROME,
      background: '#f5f7f9', foreground: '#20262d', cursor: '#20262d', cursorAccent: '#f5f7f9',
      selectionBackground: '#c7dcf4', selectionForeground: '#20262d', black: '#20262d',
      red: '#b4232c', green: '#367a3f', yellow: '#796000', blue: '#2563a6', magenta: '#7a4e9d',
      cyan: '#087d8c', white: '#6d7782', brightBlack: '#55606b', brightRed: '#d33a45',
      brightGreen: '#3f8f49', brightYellow: '#8f7200', brightBlue: '#3478bd',
      brightMagenta: '#9365b1', brightCyan: '#1593a1', brightWhite: '#343b43',
    },
  },
  {
    id: 'blue-frost',
    nameKey: 'settings.terminalTheme.presets.blueFrost',
    mode: 'light',
    theme: {
      ...LIGHT_SCROLLBAR_CHROME,
      background: '#f3f7fb', foreground: '#1f2933', cursor: '#1f2933', cursorAccent: '#f3f7fb',
      selectionBackground: '#bdd7f0', selectionForeground: '#1f2933', black: '#1f2933',
      red: '#b52d3a', green: '#35764b', yellow: '#806300', blue: '#1f69ad', magenta: '#6f55a1',
      cyan: '#087d91', white: '#65717d', brightBlack: '#52606d', brightRed: '#d3404d',
      brightGreen: '#438b59', brightYellow: '#957700', brightBlue: '#2f7fc5',
      brightMagenta: '#866cba', brightCyan: '#1595aa', brightWhite: '#36414c',
    },
  },
  {
    id: 'pure-white',
    nameKey: 'settings.terminalTheme.presets.pureWhite',
    mode: 'light',
    theme: {
      ...LIGHT_SCROLLBAR_CHROME,
      background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff',
      selectionBackground: '#b6d7ff', selectionForeground: '#1f2328', black: '#24292f',
      red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df',
      cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26',
      brightGreen: '#1a7f37', brightYellow: '#9a6700', brightBlue: '#218bff',
      brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#343941',
    },
  },
];

const DARK_PRESETS: readonly TerminalThemePreset[] = [
  {
    id: 'neutral-charcoal',
    nameKey: 'settings.terminalTheme.presets.neutralCharcoal',
    mode: 'dark',
    theme: TERMINAL_DARK_THEME,
  },
  {
    id: 'graphite-blue',
    nameKey: 'settings.terminalTheme.presets.graphiteBlue',
    mode: 'dark',
    theme: {
      ...DARK_SCROLLBAR_CHROME,
      background: '#111820', foreground: '#dce5ec', cursor: '#e7eef4', cursorAccent: '#111820',
      selectionBackground: '#293746', selectionForeground: '#f5f8fa', black: '#0f141a',
      red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd',
      cyan: '#56b6c2', white: '#abb2bf', brightBlack: '#6f7b87', brightRed: '#ef7b84',
      brightGreen: '#a7d288', brightYellow: '#f0cf8a', brightBlue: '#70befa',
      brightMagenta: '#d587ec', brightCyan: '#65c5d1', brightWhite: '#eef3f6',
    },
  },
  {
    id: 'deep-navy',
    nameKey: 'settings.terminalTheme.presets.deepNavy',
    mode: 'dark',
    theme: {
      ...DARK_SCROLLBAR_CHROME,
      background: '#0b1117', foreground: '#d8e1e8', cursor: '#e6edf3', cursorAccent: '#0b1117',
      selectionBackground: '#1f3447', selectionForeground: '#f0f6fc', black: '#070c11',
      red: '#ff7b72', green: '#7ee787', yellow: '#d2a84a', blue: '#79c0ff', magenta: '#d2a8ff',
      cyan: '#56d4dd', white: '#b1bac4', brightBlack: '#6e7681', brightRed: '#ffa198',
      brightGreen: '#9be9a8', brightYellow: '#e3b341', brightBlue: '#a5d6ff',
      brightMagenta: '#dbb7ff', brightCyan: '#76e3ea', brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'soft-slate',
    nameKey: 'settings.terminalTheme.presets.softSlate',
    mode: 'dark',
    theme: {
      ...DARK_SCROLLBAR_CHROME,
      background: '#1b2026', foreground: '#e1e7ec', cursor: '#edf2f5', cursorAccent: '#1b2026',
      selectionBackground: '#38434f', selectionForeground: '#f7f9fa', black: '#171b20',
      red: '#e88388', green: '#9acb9f', yellow: '#ddc27b', blue: '#8ab8d8', magenta: '#bca8d0',
      cyan: '#7bc2ca', white: '#cdd5db', brightBlack: '#7b8791', brightRed: '#f19398',
      brightGreen: '#aadbae', brightYellow: '#ecd18a', brightBlue: '#9ac8e8',
      brightMagenta: '#ccb8e0', brightCyan: '#8bd2da', brightWhite: '#f5f8fa',
    },
  },
];

const PRESETS = [...LIGHT_PRESETS, ...DARK_PRESETS] as const;

export function getTerminalThemePresets(mode: TerminalThemePresetMode): readonly TerminalThemePreset[] {
  return mode === 'dark' ? DARK_PRESETS : LIGHT_PRESETS;
}

export function normalizeTerminalThemePresetId(
  mode: 'light',
  value: unknown,
): TerminalLightThemePresetId;
export function normalizeTerminalThemePresetId(
  mode: 'dark',
  value: unknown,
): TerminalDarkThemePresetId;
export function normalizeTerminalThemePresetId(
  mode: TerminalThemePresetMode,
  value: unknown,
): TerminalThemePresetId;
export function normalizeTerminalThemePresetId(
  mode: TerminalThemePresetMode,
  value: unknown,
): TerminalThemePresetId {
  const match = PRESETS.find((preset) => preset.mode === mode && preset.id === value);
  if (match) return match.id;
  return mode === 'dark' ? 'neutral-charcoal' : 'lifted-neutral';
}

export function getTerminalTheme(
  isDark: boolean,
  presetId?: TerminalThemePresetId,
): TesseraTerminalTheme {
  const mode = isDark ? 'dark' : 'light';
  const resolvedId = normalizeTerminalThemePresetId(mode, presetId);
  const preset = getTerminalThemePresets(mode).find(({ id }) => id === resolvedId);
  return { ...(preset?.theme ?? (isDark ? TERMINAL_DARK_THEME : TERMINAL_LIGHT_THEME)) };
}
