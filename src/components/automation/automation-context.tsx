'use client';
import { useLoadedProjectViews, useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import type { AutomationScope } from '@/stores/automation-store';
import { useI18n } from '@/lib/i18n';
export function useAutomationContext(scope: AutomationScope) {
  const { t } = useI18n();
  const session = useProjectViewSession('sessionId' in scope ? scope.sessionId : null);
  const projects = useLoadedProjectViews();
  const project = projects.find(p => 'sessionId' in scope ? p.encodedDir === session?.originProjectId : p.projectWorktree?.id === scope.worktreeId);
  return { title: 'sessionId' in scope ? session?.title ?? t('automation.sessionMissing') : project?.projectWorktree?.currentBranch ?? project?.displayName ?? t('automation.target'),
    subtitle: project ? [project.displayName, session?.worktreeBranch ?? project.projectWorktree?.currentBranch].filter(Boolean).join(' · ') : '', session };
}
