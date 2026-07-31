'use client';

import { useSettingsStore } from '@/stores/settings-store';
import {
  useTerminalViewModeStore,
  type TerminalViewMode,
} from '@/stores/terminal-view-mode-store';

/**
 * The surface a PTY session should show right now.
 *
 * Two inputs, in order: whatever the user last toggled for this specific
 * session, then the account-wide default. An explicit per-session choice always
 * wins — someone who flipped one session to chat expects it to stay there
 * regardless of the setting.
 */
export function useTerminalViewMode(sessionId: string): TerminalViewMode {
  const stored = useTerminalViewModeStore((state) => state.modeBySession[sessionId]);
  const fallback = useSettingsStore(
    (state) => state.settings.terminalSessionDefaultView,
  );
  return stored ?? fallback ?? 'terminal';
}
