'use client';

import { useGitStore } from '@/stores/git-store';
import { useSettingsStore } from '@/stores/settings-store';
import { isPhoneViewport } from './phone-viewport';

/**
 * The two panels that are full-screen overlays at a Phone viewport (#258).
 *
 * On a desktop the sidebar and the Git panel are columns beside the content, so
 * whatever they open is on screen the moment it opens and there is nothing to
 * step aside from. Below the Phone viewport step both become `fixed inset-0`,
 * and the thing they open opens *behind* them: the tab bar has already switched
 * to the new session or the new file, and the screen still shows the list it
 * was tapped in. The user gets no signal at all — that illusion is what
 * produced #260, a ticket filed against a feature that worked.
 *
 * So once a tap has opened something, the overlay it was opened from steps
 * aside. Only taps that change what is being shown call these: expanding a
 * collection, switching the All/Running filter and expanding a folder open
 * nothing and never reach here, which is why the panel survives them without
 * any logic of its own.
 *
 * Above the step both are no-ops, which is what keeps Compact and desktop
 * behaviour unchanged. Getting the panel back is the same one tap on the same
 * control in the tab bar as before.
 */
export function stepAsidePhoneSidebar(): void {
  if (!isPhoneViewport()) return;
  useSettingsStore.getState().setSidebarCollapsed(true);
}

/** The Git panel's half of the rule above. */
export function stepAsidePhoneGitPanel(): void {
  if (!isPhoneViewport()) return;
  useGitStore.getState().close();
}
