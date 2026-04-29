export type ShortcutCategory = 'tab' | 'view' | 'panel' | 'input';

export interface ShortcutDefinition {
  /** tinykeys-style key string. e.g. '$mod+Alt+t' */
  default: string;
  category: ShortcutCategory;
  /** i18n key for the action description. */
  descKey: string;
}

export const SHORTCUT_REGISTRY = {
  'new-tab':        { default: '$mod+Alt+t',          category: 'tab',   descKey: 'shortcut.newTab' },
  'close-tab':      { default: '$mod+Alt+w',          category: 'tab',   descKey: 'shortcut.closeTab' },
  'next-tab':       { default: '$mod+Alt+ArrowRight', category: 'tab',   descKey: 'shortcut.nextTab' },
  'prev-tab':       { default: '$mod+Alt+ArrowLeft',  category: 'tab',   descKey: 'shortcut.prevTab' },
  'toggle-sidebar': { default: '$mod+Alt+b',          category: 'view',  descKey: 'shortcut.toggleSidebar' },
  'toggle-view':    { default: '$mod+Alt+k',          category: 'view',  descKey: 'shortcut.toggleView' },
  'split-right':    { default: '$mod+Alt+\\',         category: 'panel', descKey: 'shortcut.splitRight' },
  'split-down':     { default: '$mod+Alt+-',          category: 'panel', descKey: 'shortcut.splitDown' },
  'voice-input':    { default: '$mod+Alt+v',          category: 'input', descKey: 'shortcut.voiceInput' },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUT_REGISTRY;

export const SHORTCUT_IDS = Object.keys(SHORTCUT_REGISTRY) as ShortcutId[];
