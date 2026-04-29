/**
 * Keyboard Manager
 *
 * Central keyboard shortcut management system.
 * Provides registration, unregistration, and context-aware shortcut handling.
 *
 * Features:
 * - Cross-platform modifier keys (Ctrl/Cmd)
 * - Browser default behavior prevention
 * - Input field context detection
 * - Dynamic shortcut registration/unregistration
 *
 * @example
 * const manager = new KeyboardManager();
 * manager.register('$mod+t', () => console.log('New session'), { ignoreInputFields: false });
 * manager.unregisterAll(); // cleanup
 */

import { tinykeys } from 'tinykeys';

export interface ShortcutOptions {
  /**
   * If true, shortcut will not trigger when user is typing in input/textarea.
   * Default: false (shortcut works everywhere)
   */
  ignoreInputFields?: boolean;
}

interface RegisteredShortcut {
  handler: () => void;
  options: ShortcutOptions;
}

export class KeyboardManager {
  private handlers: Map<string, RegisteredShortcut>;
  private unsubscribe?: () => void;

  constructor() {
    this.handlers = new Map();
  }

  /**
   * Register a keyboard shortcut
   *
   * @param shortcut - Shortcut pattern (e.g., '$mod+t', 'Ctrl+Shift+Tab')
   * @param handler - Function to call when shortcut is triggered
   * @param options - Configuration options
   *
   * @example
   * manager.register('$mod+t', handleNewSession, { ignoreInputFields: false });
   */
  register(shortcut: string, handler: () => void, options: ShortcutOptions = {}) {
    this.handlers.set(shortcut, { handler, options });
    this.updateBindings();
  }

  /**
   * Unregister a specific keyboard shortcut
   *
   * @param shortcut - Shortcut pattern to remove
   */
  unregister(shortcut: string) {
    this.handlers.delete(shortcut);
    this.updateBindings();
  }

  /**
   * Unregister all keyboard shortcuts and cleanup event listeners
   */
  unregisterAll() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.handlers.clear();
  }

  /**
   * Update tinykeys bindings based on current registered shortcuts
   * @private
   */
  private updateBindings() {
    // Unsubscribe previous bindings
    if (this.unsubscribe) {
      this.unsubscribe();
    }

    // Create new bindings
    const bindings: Record<string, (event: KeyboardEvent) => void> = {};
    this.handlers.forEach(({ handler, options }, shortcut) => {
      bindings[shortcut] = (event: KeyboardEvent) => {
        if (this.shouldIgnoreShortcut(event, options)) {
          return;
        }

        // Prevent browser default behavior
        event.preventDefault();
        event.stopPropagation();

        // Execute handler
        handler();
      };
    });

    if (typeof window !== 'undefined') {
      this.unsubscribe = tinykeys(window, bindings);
    }
  }

  /**
   * Check if shortcut should be ignored based on context
   * @private
   */
  private shouldIgnoreShortcut(event: KeyboardEvent, options: ShortcutOptions): boolean {
    const target = event.target as HTMLElement;

    // Check if user is typing in input field
    const isInputField =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable;

    // Ignore shortcut if option is set and user is in input field
    return options.ignoreInputFields === true && isInputField;
  }
}
