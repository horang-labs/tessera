declare module 'tinykeys' {
  export type KeyBindingMap = Record<string, (event: KeyboardEvent) => void>;

  export type KeyBindingPress = [mods: string[], key: string | RegExp];

  export function parseKeybinding(str: string): KeyBindingPress[];

  export function matchKeyBindingPress(
    event: KeyboardEvent,
    press: KeyBindingPress
  ): boolean;

  export function tinykeys(
    target: Window | HTMLElement,
    keyBindingMap: KeyBindingMap,
    options?: { event?: 'keydown' | 'keyup'; capture?: boolean; timeout?: number }
  ): () => void;
}
