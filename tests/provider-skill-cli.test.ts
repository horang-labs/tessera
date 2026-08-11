import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProviderIntegration, type ProviderSkillId } from '@/lib/cli/provider-integration';
import { createControlHttpHandler } from '@/lib/control/http-handler';
import { publishRuntimeDescriptor } from '@/lib/control/runtime-descriptor';
import { createControlService } from '@/lib/control/service';
import { runControlCli } from './helpers/control-cli-runner';

const REPO_ROOT = process.cwd();
const PACKAGE_VERSION = JSON.parse(
  fsSync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
).version as string;
const PROVIDERS: ProviderSkillId[] = ['claude-code', 'codex', 'opencode'];

test('CLI manages default and explicit provider sets through Provider Integration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-provider-skill-cli-'));
  const homes = Object.fromEntries(PROVIDERS.map((providerId) => [
    providerId,
    path.join(root, 'wsl-homes', providerId),
  ])) as Record<ProviderSkillId, string>;
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'wsl',
    detectSkillProviders: async () => PROVIDERS,
    resolveProviderSkillHome: async (providerId) => homes[providerId],
    providerSkillStateDirectory: path.join(root, 'state'),
    readProviderSkillFiles: () => [{
      relativePath: 'SKILL.md',
      content: '---\nname: tessera-cli\ndescription: CLI test\n---\n',
    }],
  });
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const descriptor = await publishRuntimeDescriptor({
    appVersion: PACKAGE_VERSION,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    runtimeDirectory: path.join(root, 'runtime'),
  });
  const service = createControlService({
    appVersion: PACKAGE_VERSION,
    runtimeId: descriptor.descriptor.runtimeId,
    projects: { list: () => [], get: () => undefined },
    worktrees: { list: () => [], get: () => undefined },
    providerIntegration: integration,
    resolveUserId: async () => 'cli-user',
  });
  const handler = createControlHttpHandler({ descriptor: descriptor.descriptor, service });
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  const runUserGlobalCli = (args: string[]) => runControlCli(args, {
    envOverrides: {
      TESSERA_PROJECT_ID: '',
      TESSERA_SESSION_ID: '',
      TESSERA_WORKTREE_ID: '',
    },
  });

  try {
    const install = await runUserGlobalCli([
      'skills', 'install', '--json', '--control-descriptor', descriptor.path,
    ]);
    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(
      JSON.parse(install.stdout).data.providers.map((provider: { providerId: string }) => (
        provider.providerId
      )),
      PROVIDERS,
    );
    for (const providerId of PROVIDERS) {
      assert.equal(
        fsSync.existsSync(path.join(homes[providerId], 'skills', 'tessera-cli', 'SKILL.md')),
        true,
      );
    }

    const status = await runUserGlobalCli([
      'skills', 'status', '--provider', 'codex', '--json',
      '--control-descriptor', descriptor.path,
    ]);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).data.providers, [{
      providerId: 'codex',
      detected: true,
      state: 'ready',
      consent: 'granted',
      ownership: 'tessera',
    }]);

    const update = await runUserGlobalCli([
      'skills', 'update', '--provider', 'codex', '--json',
      '--control-descriptor', descriptor.path,
    ]);
    assert.equal(update.code, 0, update.stderr);
    assert.equal(JSON.parse(update.stdout).data.providers[0].state, 'ready');

    const remove = await runUserGlobalCli([
      'skills', 'remove', '--provider', 'codex', '--json',
      '--control-descriptor', descriptor.path,
    ]);
    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(JSON.parse(remove.stdout).data.providers, [{
      providerId: 'codex',
      detected: true,
      state: 'absent',
      consent: 'revoked',
      ownership: 'none',
    }]);
    assert.equal(
      fsSync.existsSync(path.join(homes.codex, 'skills', 'tessera-cli')),
      false,
    );
    assert.equal(
      fsSync.existsSync(path.join(homes.opencode, 'skills', 'tessera-cli')),
      true,
    );

    const reinstall = await runUserGlobalCli([
      'skills', 'install', '--provider', 'codex', '--json',
      '--control-descriptor', descriptor.path,
    ]);
    assert.equal(reinstall.code, 0, reinstall.stderr);
    const codexSkillPath = path.join(homes.codex, 'skills', 'tessera-cli', 'SKILL.md');
    fsSync.appendFileSync(codexSkillPath, 'external CLI edit\n');
    const conflict = await runUserGlobalCli([
      'skills', 'update', '--provider', 'codex', '--json',
      '--control-descriptor', descriptor.path,
    ]);
    assert.equal(conflict.code, 1);
    assert.equal(JSON.parse(conflict.stdout).error.code, 'PROVIDER_SKILL_CONFLICT');
    assert.match(fsSync.readFileSync(codexSkillPath, 'utf8'), /external CLI edit/);

    const invalid = await runUserGlobalCli([
      'skills', 'status', '--provider', 'gemini', '--json',
      '--control-descriptor', descriptor.path,
    ]);
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_USAGE');

    const managedSessionAttempt = await runControlCli([
      'skills', 'remove', '--provider', 'opencode', '--json',
      '--control-descriptor', descriptor.path,
    ], {
      envOverrides: {
        TESSERA_PROJECT_ID: 'managed-project',
        TESSERA_SESSION_ID: 'managed-session',
      },
    });
    assert.equal(managedSessionAttempt.code, 1);
    assert.equal(
      JSON.parse(managedSessionAttempt.stdout).error.code,
      'PROVIDER_SKILL_GLOBAL_AUTHORITY_REQUIRED',
    );
    assert.equal(
      fsSync.existsSync(path.join(homes.opencode, 'skills', 'tessera-cli')),
      true,
    );
  } finally {
    await descriptor.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
