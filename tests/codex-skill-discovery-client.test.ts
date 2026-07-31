import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listCodexSkills,
  setCodexSkillDiscoveryRequestExecutorForTests,
} from '@/lib/cli/providers/codex/skill-discovery-client';

test.afterEach(() => {
  setCodexSkillDiscoveryRequestExecutorForTests(null);
});

test('Codex skills are discovered by cwd without creating a thread', async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  setCodexSkillDiscoveryRequestExecutorForTests(async (_context, method, params) => {
    requests.push({ method, params });
    return {
      data: [{
        cwd: '/repo',
        errors: [],
        skills: [
          { name: 'diagnosing-bugs', description: 'Diagnose bugs', path: '/skills/bugs/SKILL.md', enabled: true },
          { name: 'disabled-skill', description: 'Disabled', path: '/skills/off/SKILL.md', enabled: false },
          { name: '', description: 'Invalid', path: '/skills/invalid/SKILL.md', enabled: true },
        ],
      }],
    };
  });

  const skills = await listCodexSkills({
    userId: 'user-1',
    workDir: '/repo',
    environment: 'wsl',
  });

  assert.deepEqual(requests, [{
    method: 'skills/list',
    params: { cwds: ['/repo'], forceReload: true },
  }]);
  assert.deepEqual(skills, [{
    name: 'diagnosing-bugs',
    description: 'Diagnose bugs',
    path: '/skills/bugs/SKILL.md',
  }]);
});
