import path from 'node:path';
import * as dbProjects from '@/lib/db/projects';
import { shouldAutoRegisterCurrentProject } from './current-project';

/** Keep implicit development-worktree registration at the startup write seam. */
export function registerCurrentProjectAtStartup(
  currentProjectId = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    !shouldAutoRegisterCurrentProject(currentProjectId, env)
    || dbProjects.isRegistered(currentProjectId)
  ) {
    return false;
  }

  dbProjects.registerProject(
    currentProjectId,
    currentProjectId,
    path.basename(currentProjectId),
  );
  return true;
}
