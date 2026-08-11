import type { GitMenuAction } from './git-action-menu';
import type { GitPrimaryAction } from './primary-git-action';

const SESSION_REQUIRED_REASON = 'gitPanel.primary.sessionRequired' as const;

/**
 * A canonical Worktree can be inspected without a Session, but Git mutations
 * still run through a Session so provider, refresh, and PR ownership stay
 * explicit. Preserve the real repository-derived rung and disable only an
 * action that would otherwise be clickable and silently discarded.
 */
export function restrictPrimaryGitActionToSession(
  action: GitPrimaryAction,
  hasSession: boolean,
): GitPrimaryAction {
  if (
    hasSession
    || action.action === null
    || action.action === 'view_pr'
    || action.action === 'resolve_conflicts'
  ) {
    return action;
  }
  if (!action.enabled && action.disabledReasonKey !== 'gitPanel.pr.statusUnknown') {
    return action;
  }
  return {
    ...action,
    enabled: false,
    disabledReasonKey: SESSION_REQUIRED_REASON,
  };
}

/** Keep navigation available while refusing session-owned Git mutations. */
export function restrictGitMenuToSession(
  actions: readonly GitMenuAction[],
  hasSession: boolean,
): readonly GitMenuAction[] {
  if (hasSession) return actions;
  return actions.map((action) => {
    if (action.id === 'open_source_control' || action.kind === 'view_pr') {
      return action;
    }
    if (!action.enabled && action.disabledReasonKey !== 'gitPanel.pr.statusUnknown') return action;
    return {
      ...action,
      enabled: false,
      disabledReasonKey: SESSION_REQUIRED_REASON,
    };
  });
}
