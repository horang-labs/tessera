/**
 * Keyboard Shortcut Provider
 *
 * Global provider component that registers app-level keyboard shortcuts.
 *
 * Usage: Wrap the entire app or ChatLayout with this provider.
 *
 * @example
 * <KeyboardShortcutProvider>
 *   <ChatLayout />
 * </KeyboardShortcutProvider>
 */

'use client';

import { ReactNode } from 'react';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';

export interface KeyboardShortcutProviderProps {
  children: ReactNode;
}

export function KeyboardShortcutProvider({ children }: KeyboardShortcutProviderProps) {
  // Register all app-level shortcuts
  useKeyboardShortcuts();

  return <>{children}</>;
}
