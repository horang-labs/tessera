import { getAgentEnvironment, normalizeCwdForCliEnvironment } from '@/lib/cli/spawn-cli';
import type { SkillInfo } from '../skill-types';
import {
  executeCodexAppServerRequest,
  setCodexAppServerRequestExecutorForTests,
  type CodexAppServerRequestContext,
  type CodexAppServerRequestExecutor,
} from './app-server-request-client';

interface CodexSkillsListResponse {
  data?: Array<{
    cwd?: unknown;
    skills?: Array<{
      name?: unknown;
      description?: unknown;
      path?: unknown;
      enabled?: unknown;
    }>;
    errors?: unknown;
  }>;
}

export type CodexSkillDiscoveryContext = CodexAppServerRequestContext;
export type CodexSkillDiscoveryRequestExecutor = CodexAppServerRequestExecutor;
export const setCodexSkillDiscoveryRequestExecutorForTests =
  setCodexAppServerRequestExecutorForTests;

/** Lists cwd-scoped Codex skills without starting or resuming a conversation thread. */
export async function listCodexSkills(
  context: CodexSkillDiscoveryContext,
): Promise<SkillInfo[]> {
  const environment = context.environment ?? await getAgentEnvironment(context.userId);
  const requestedCwd = context.workDir?.trim() || process.cwd();
  const cwd = normalizeCwdForCliEnvironment(requestedCwd, environment);
  const result = await executeCodexAppServerRequest<CodexSkillsListResponse>(
    { ...context, environment, workDir: requestedCwd },
    'skills/list',
    { cwds: [cwd], forceReload: true },
  );
  const entries: SkillInfo[] = [];

  for (const group of Array.isArray(result?.data) ? result.data : []) {
    for (const skill of Array.isArray(group.skills) ? group.skills : []) {
      if (skill.enabled === false) continue;

      const name = typeof skill.name === 'string' ? skill.name.slice(0, 100) : '';
      if (!name) continue;

      const entry: SkillInfo = {
        name,
        description: typeof skill.description === 'string'
          ? skill.description.slice(0, 500)
          : '',
      };
      if (typeof skill.path === 'string' && skill.path) {
        entry.path = skill.path;
      }
      entries.push(entry);
    }
  }

  return entries;
}
