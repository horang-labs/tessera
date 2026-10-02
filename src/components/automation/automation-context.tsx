'use client';
import { useLoadedProjectViews, useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import type { AutomationScope } from '@/stores/automation-store';
import { useI18n } from '@/lib/i18n';
import { useTaskStore } from '@/stores/task-store';
export function useAutomationContext(scope: AutomationScope) {
  const { t } = useI18n();
  const session = useProjectViewSession('sessionId' in scope ? scope.sessionId : null);
  const projects = useLoadedProjectViews();
  const tasksByProject = useTaskStore(state => state.tasksByProject);
  const tasks = useTaskStore(state => state.tasks);
  const task = 'worktreeId' in scope ? [...Object.values(tasksByProject).flat(), ...tasks].find(task => task.worktreeId === scope.worktreeId) : undefined;
  const project = projects.find(p => 'sessionId' in scope ? p.encodedDir === session?.originProjectId
    : task ? p.encodedDir === task.projectId : p.projectWorktree?.id === scope.worktreeId);
  const branch = session?.worktreeBranch ?? task?.worktreeBranch ?? project?.projectWorktree?.currentBranch;
  return { title: 'sessionId' in scope ? session?.title ?? t('automation.sessionMissing') : task?.worktreeBranch ?? task?.title ?? project?.projectWorktree?.currentBranch ?? project?.displayName ?? t('automation.target'),
    subtitle: project ? [project.displayName, branch].filter(Boolean).join(' · ') : branch ?? '', session };
}
