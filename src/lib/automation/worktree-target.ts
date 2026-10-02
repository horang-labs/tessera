import { getDb } from '../db/database';
import { getWorktree } from '../db/worktrees';
import { isGitCheckoutPath } from '../db/worktree-identity';
import { fail } from './service';
import { createSession } from '../db/sessions';
import { nativeAutomationServiceTier } from './service-tier';
import type { Target } from './contracts';

/** Resolve registered ownership without treating every canonical checkout as a Task. */
export function resolveAutomationWorktree(worktreeId:string) {
  const worktree=getWorktree(worktreeId);
  if(!worktree?.filesystemPath||!isGitCheckoutPath(worktree.filesystemPath))fail('NOT_FOUND','A live Worktree is required.');
  const task=getDb().prepare(`SELECT t.id, t.project_id, t.archived, t.worktree_deleted_at, p.id AS registered_project
    FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.public_worktree_id=?`).get(worktree.id) as
    {id:string;project_id:string;archived:number;worktree_deleted_at:string|null;registered_project:string|null}|undefined;
  if(task){
    if(task.archived||task.worktree_deleted_at||!task.registered_project)fail('NOT_FOUND');
    return {worktreeId:worktree.id,workDir:worktree.filesystemPath,projectId:task.project_id,taskId:task.id};
  }
  const project=getDb().prepare('SELECT id FROM projects WHERE project_worktree_id=? ORDER BY registered_at,id LIMIT 1')
    .get(worktree.id) as {id:string}|undefined;
  if(!project)fail('NOT_FOUND');
  return {worktreeId:worktree.id,workDir:worktree.filesystemPath,projectId:project.id,taskId:null};
}

/** Runs in the authority's reservation transaction; never creates a Worktree or Task. */
export function createReservedAutomationSession(sessionId:string,target:Extract<Target,{kind:'create-session'}>):void {
  const context=resolveAutomationWorktree(target.worktreeId);
  createSession(sessionId,context.projectId,target.title.trim()||'New Session',target.selection.provider,{
    ...(context.taskId ? {taskId:context.taskId} : {worktreeId:context.worktreeId,workDir:context.workDir,worktreeManaged:false}),
    providerState:JSON.stringify({kind:'terminal'}),model:target.selection.model,reasoningEffort:target.selection.reasoningEffort,
    serviceTier:nativeAutomationServiceTier(target.selection.provider,target.selection.serviceTier),
  });
}
