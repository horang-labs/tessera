import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  TESSERA_CLI_SKILL_INSTALL_COMMAND,
  createTesseraCliSkillManager,
} from '@/lib/cli/tessera-cli-skill';

test('skill inspection derives the Skills CLI lock from its reported installation', async () => {
  const source = await readFile('src/lib/cli/tessera-cli-skill.ts', 'utf8');
  assert.match(source, /path\.dirname\(path\.dirname\(installationPath\)\)/);
  assert.doesNotMatch(source, /resolveAgentHomeFilesystemPath/);
});

test('tessera-cli setup inspects the standard Skills CLI in the selected Agent Environment', async () => {
  const calls: Array<{ command: string; args: string[]; environment: string }> = [];
  const manager = createTesseraCliSkillManager({
    exec: async (command, args, environment) => {
      calls.push({ command, args, environment });
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify([{
          name: 'tessera-cli',
          path: '/home/test/.agents/skills/tessera-cli',
          scope: 'global',
          agents: ['Codex'],
          source: 'horang-labs/tessera',
          sourceUrl: 'https://github.com/horang-labs/tessera',
          sourceType: 'github',
        }]),
        stderr: '',
        timedOut: false,
        durationMs: 1,
      };
    },
    inspectInstallation: async () => 'current',
  });

  const result = await manager.inspect('wsl');

  assert.equal(TESSERA_CLI_SKILL_INSTALL_COMMAND, 'npx skills add https://github.com/horang-labs/tessera --skill tessera-cli --global');
  assert.deepEqual(calls, [{
    command: 'npx',
    args: ['--yes', 'skills', 'list', '--global', '--json'],
    environment: 'wsl',
  }]);
  assert.equal(result.state, 'installed');
  assert.deepEqual(result.agents, ['Codex']);
});

test('tessera-cli setup reports source conflicts and externally modified installations', async () => {
  const entry = (sourceUrl: string) => JSON.stringify([{
    name: 'tessera-cli',
    path: '/home/test/.agents/skills/tessera-cli',
    scope: 'global',
    agents: ['Codex'],
    sourceUrl,
  }]);
  let stdout = entry('https://example.com/not-tessera');
  const manager = createTesseraCliSkillManager({
    exec: async () => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1 }),
    inspectInstallation: async () => 'modified',
  });

  assert.equal((await manager.inspect('native')).state, 'conflict');
  stdout = entry('https://github.com/horang-labs/tessera');
  assert.equal((await manager.inspect('native')).state, 'conflict');
});

test('tessera-cli removal fails closed when ownership inspection fails', async () => {
  const calls: string[][] = [];
  const manager = createTesseraCliSkillManager({
    exec: async (_command, args) => {
      calls.push(args);
      return {
        ok: false, exitCode: 1, stdout: '', stderr: 'ownership status unavailable',
        timedOut: false, durationMs: 1,
      };
    },
  });

  const result = await manager.remove('wsl');

  assert.equal(result.state, 'setup-failed');
  assert.equal(result.message, 'ownership status unavailable');
  assert.deepEqual(calls, [['--yes', 'skills', 'list', '--global', '--json']]);
});
