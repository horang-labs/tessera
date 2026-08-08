import {
  getSpecialSessionTitle,
  getSpecialSessionTitleKey,
  isSpecialSession,
} from '@/lib/constants/special-sessions';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface TabDisplayTitleInput {
  /** The tab's own title, set when the user renamed the tab itself. */
  tabTitle: string | null;
  /** Session on the tab's active panel, if any. */
  activePanelSessionId: string | null;
  /** Terminal on the tab's active panel, if any. */
  activePanelTerminalId: string | null;
  /** The session record, when the session store already holds it. */
  session: { id: string; title?: string | null } | undefined;
  t: Translate;
}

/**
 * The name a tab shows.
 *
 * Extracted from `tab-item.tsx` rather than copied: at Phone viewport the strip
 * is replaced by a control that names the same tabs (#247), and a second copy of
 * this chain would let the two surfaces drift apart on the device where only one
 * of them renders.
 */
export function resolveTabDisplayTitle({
  tabTitle,
  activePanelSessionId,
  activePanelTerminalId,
  session,
  t,
}: TabDisplayTitleInput): string {
  if (tabTitle !== null) return tabTitle;

  const fallback = t('chat.newTabDefault');

  const specialTitleKey = activePanelSessionId
    ? getSpecialSessionTitleKey(activePanelSessionId)
    : null;
  if (specialTitleKey) return t(specialTitleKey);

  if (activePanelSessionId && isSpecialSession(activePanelSessionId)) {
    return getSpecialSessionTitle(activePanelSessionId, t) ?? fallback;
  }

  if (activePanelTerminalId) return 'Terminal';

  if (activePanelSessionId && session) return session.title ?? session.id;

  return fallback;
}
