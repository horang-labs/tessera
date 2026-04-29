import {
  getWorkspaceSpecialSessionTitle,
  getWorkspaceSpecialSourceSessionId,
  parseWorkspaceSpecialSessionId,
} from '@/lib/workspace-tabs/special-session';

/**
 * Special session IDs for non-chat panel content.
 * These IDs are never stored in the session store —
 * PanelLeaf and TabItem handle them as special cases.
 */
export const SKILLS_DASHBOARD_SESSION_ID = '__skills-dashboard__' as const;
export const ARCHIVE_DASHBOARD_SESSION_ID = '__archive-dashboard__' as const;

/** Check if a sessionId is a special (non-chat) session */
export function isSpecialSession(sessionId: string | null): boolean {
  if (sessionId && parseWorkspaceSpecialSessionId(sessionId)) return true;
  return sessionId === SKILLS_DASHBOARD_SESSION_ID
    || sessionId === ARCHIVE_DASHBOARD_SESSION_ID;
}

/** Get display title for a special session ID */
export function getSpecialSessionTitle(sessionId: string): string | null {
  if (sessionId === SKILLS_DASHBOARD_SESSION_ID) return 'Skills Dashboard';
  if (sessionId === ARCHIVE_DASHBOARD_SESSION_ID) return 'Archive';
  return getWorkspaceSpecialSessionTitle(sessionId);
}

/** Get i18n title key for a special session ID */
export function getSpecialSessionTitleKey(sessionId: string): string | null {
  if (sessionId === SKILLS_DASHBOARD_SESSION_ID) return 'skill.dashboardTitle';
  if (sessionId === ARCHIVE_DASHBOARD_SESSION_ID) return 'archive.title';
  return null;
}

export function getSpecialSessionSourceSessionId(sessionId: string): string | null {
  return getWorkspaceSpecialSourceSessionId(sessionId);
}

/**
 * ID used by task/session selection surfaces.
 * Workspace file tabs stay active as special sessions, but their source task
 * should be highlighted and used as the list/board selection anchor.
 */
export function getSessionSelectionId(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return getSpecialSessionSourceSessionId(sessionId) ?? sessionId;
}
