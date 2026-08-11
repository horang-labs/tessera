import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const [fakeCodex, authoritativeHome, dataDir, stateKey] = process.argv.slice(2);
if (!fakeCodex || !authoritativeHome || !dataDir || !stateKey) {
  throw new Error('Expected fake Codex, authoritative home, data dir, and state key.');
}

process.env.NODE_ENV = 'test';
process.env.TESSERA_DATA_DIR = dataDir;
process.env.CODEX_HOME = authoritativeHome;
process.env.TESSERA_TEST_CODEX_STATE_KEY = stateKey;
delete process.env.TESSERA_CODEX_HOME;
fs.mkdirSync(dataDir, { recursive: true });

async function main(): Promise<void> {
  const [{ CodexAdapter }, { createProviderIntegration }, { SettingsManager }] =
    await Promise.all([
    import('@/lib/cli/providers/codex/adapter'),
    import('@/lib/cli/provider-integration'),
    import('@/lib/settings/manager'),
    ]);
  const userId = `restart-harness-${path.basename(dataDir)}`;
  const settings = await SettingsManager.load(userId, { silent: true });
  await SettingsManager.save(userId, {
  ...settings,
  agentEnvironment: 'wsl',
  cliCommandOverrides: {
    ...settings.cliCommandOverrides,
    codex: { ...settings.cliCommandOverrides.codex, wsl: fakeCodex },
  },
  });
  const integration = createProviderIntegration({
  resolveAgentEnvironment: async () => 'wsl',
  lifecycle: {
    inspect: async () => ({ state: 'installed', trust: 'trusted' }),
    install: async () => ({ state: 'installed', trust: 'trusted' }),
  },
  });
  const adapter = new CodexAdapter({
  providerIntegration: integration,
  resolveProviderHome: async () => authoritativeHome,
  });
  const result = await adapter.spawn(process.cwd(), {
  userId,
  sessionId: `restart-harness-${process.pid}`,
  startupTimeoutMs: 2_000,
  rawLog: (event) => {
    if (event.direction === 'stderr') process.stdout.write(event.data);
  },
  });
  if (!result.ok) throw result.error ?? new Error('Fake Codex launch failed.');
  const closed = once(result.process, 'close');
  result.process.kill('SIGTERM');
  await closed;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
