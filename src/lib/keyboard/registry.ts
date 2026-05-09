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
  'toggle-terminal': { default: 'Control+`',          category: 'panel', descKey: 'shortcut.toggleTerminal' },
  'focus-panel-left':  { default: '$mod+Alt+Shift+ArrowLeft',  category: 'panel', descKey: 'shortcut.focusPanelLeft' },
  'focus-panel-right': { default: '$mod+Alt+Shift+ArrowRight', category: 'panel', descKey: 'shortcut.focusPanelRight' },
  'focus-panel-up':    { default: '$mod+Alt+Shift+ArrowUp',    category: 'panel', descKey: 'shortcut.focusPanelUp' },
  'focus-panel-down':  { default: '$mod+Alt+Shift+ArrowDown',  category: 'panel', descKey: 'shortcut.focusPanelDown' },
  'voice-input':    { default: '$mod+Alt+v',          category: 'input', descKey: 'shortcut.voiceInput' },
  'toggle-plan-mode':        { default: '$mod+Alt+p', category: 'input', descKey: 'shortcut.togglePlanMode' },
  'open-model-selector':     { default: '$mod+Alt+m', category: 'input', descKey: 'shortcut.openModelSelector' },
  'open-reasoning-selector': { default: '$mod+Alt+r', category: 'input', descKey: 'shortcut.openReasoningSelector' },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUT_REGISTRY;

export const SHORTCUT_IDS = Object.keys(SHORTCUT_REGISTRY) as ShortcutId[];
