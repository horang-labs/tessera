import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CliProvider } from '@/lib/cli/providers/types';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-managed-codex-home-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

let dbSessions: typeof import('@/lib/db/sessions');

test.before(async () => {
  const [database, sessions, projects] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/sessions'),
    import('@/lib/db/projects'),
  ]);
  await database.initDatabase();
  projects.registerProject('managed-home-project', dataDir, 'Managed Home');
  dbSessions = sessions;
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('origin provider home identity is immutable and legacy/unmanaged rows stay unbound', () => {
  dbSessions.createSession('managed-a', 'managed-home-project', 'Managed A', 'codex');
  dbSessions.createSession('managed-b', 'managed-home-project', 'Managed B', 'codex', {
    originProviderHomeIdentity: 'codex-home:b',
  });
  dbSessions.createSession('legacy', 'managed-home-project', 'Legacy overlay', 'codex');
  dbSessions.createSession('other-provider', 'managed-home-project', 'Claude', 'claude-code');

  assert.equal(
    dbSessions.bindSessionOriginProviderHome('managed-a', 'codex-home:a'),
    true,
  );
  assert.equal(
    dbSessions.bindSessionOriginProviderHome('managed-a', 'codex-home:a'),
    true,
  );
  assert.throws(
    () => dbSessions.bindSessionOriginProviderHome('managed-a', 'codex-home:b'),
    /already bound to a different provider home/i,
  );
  assert.equal(dbSessions.getSession('managed-a')?.origin_provider_home_identity, 'codex-home:a');
  assert.equal(dbSessions.getSession('legacy')?.origin_provider_home_identity, null);
  assert.equal(
    dbSessions.countManagedCodexSessionsUnavailableInHome('codex-home:b'),
    1,
  );
});

test('Provider Integration rejects a different origin home and unavailable provider history', async () => {
  const {
    createProviderIntegration,
    ProviderSessionResumeUnavailableError,
  } = await import('@/lib/cli/provider-integration');
  let inspectionState: 'available' | 'missing' | 'already-loaded' = 'available';
  let inspections = 0;
  const provider = {
    getProviderId: () => 'codex',
    getProviderIntegrationRequirements: () => ({
      lifecycle: 'not-applicable' as const,
      skill: 'not-applicable' as const,
      launchEnvironment: 'required' as const,
    }),
    prepareLaunchIntegration: async () => ({
      providerHomeIdentity: 'codex-home:current',
      buildEnvironment: (environment: NodeJS.ProcessEnv) => environment,
      inspectResume: async () => {
        inspections += 1;
        return inspectionState === 'available'
          ? { state: 'available' as const }
          : {
              state: 'unavailable' as const,
              reason: inspectionState === 'missing'
                ? 'provider-history-missing' as const
                : 'provider-session-already-running' as const,
              message: inspectionState,
            };
      },
    }),
  } as Pick<
    CliProvider,
    'getProviderId' | 'getProviderIntegrationRequirements' | 'prepareLaunchIntegration'
  >;
  const integration = createProviderIntegration({
    resolveAgentEnvironment: async () => 'native',
  });

  await assert.rejects(
    integration.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'managed-home-user' },
      requiredProviderHomeIdentity: 'codex-home:former',
      resumeProviderSessionId: 'thread-managed',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionResumeUnavailableError);
      assert.equal(error.reason, 'origin-home-not-authoritative');
      return true;
    },
  );
  assert.equal(inspections, 0, 'an inactive origin home must not inspect/reroute provider history');

  inspectionState = 'missing';
  await assert.rejects(
    integration.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'managed-home-user' },
      requiredProviderHomeIdentity: 'codex-home:current',
      resumeProviderSessionId: 'thread-managed',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionResumeUnavailableError);
      assert.equal(error.reason, 'provider-history-missing');
      return true;
    },
  );

  inspectionState = 'already-loaded';
  await assert.rejects(
    integration.resolveLaunch({
      provider,
      agentEnvironmentOwner: { kind: 'user', userId: 'managed-home-user' },
      requiredProviderHomeIdentity: 'codex-home:current',
      resumeProviderSessionId: 'thread-managed',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionResumeUnavailableError);
      assert.equal(error.reason, 'provider-session-already-running');
      return true;
    },
  );
});

test('provider home fingerprints canonicalize aliases and agent-visible path spelling', async () => {
  const {
    fingerprintCodexProviderHome,
    resolveCodexProviderHomeIdentity,
  } = await import(
    '@/lib/cli/providers/codex/provider-home'
  );
  const actualHome = path.join(dataDir, 'fingerprint-home');
  const aliasHome = path.join(dataDir, 'fingerprint-alias');
  fs.mkdirSync(actualHome, { recursive: true });
  fs.symlinkSync(actualHome, aliasHome, 'dir');
  assert.equal(
    fingerprintCodexProviderHome('wsl', actualHome),
    fingerprintCodexProviderHome('wsl', aliasHome),
  );

  const identity = (providerHome: string) => fingerprintCodexProviderHome(
    'native',
    providerHome,
    {
      realpath: (value) => value,
      formatForAgent: (value) => value,
    },
  );
  assert.equal(
    identity('C:\\Users\\Work\\.codex'),
    identity('c:/users/work/.CODEX/'),
  );

  const bridgedIdentity = (providerHome: string) => fingerprintCodexProviderHome(
    'wsl',
    providerHome,
    {
      realpath: (value) => value,
      wslDistroName: () => 'Ubuntu-24.04',
    },
  );
  assert.equal(
    bridgedIdentity('\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.codex'),
    bridgedIdentity('/home/work/.codex'),
  );
  assert.notEqual(
    bridgedIdentity('/home/work/.codex'),
    fingerprintCodexProviderHome(
      'wsl',
      '\\\\wsl.localhost\\Debian\\home\\work\\.codex',
      {
        realpath: (value) => value,
        wslDistroName: () => 'Ubuntu-24.04',
      },
    ),
  );

  const mountedHomeIdentity = async (distro: string) => (
    await resolveCodexProviderHomeIdentity(
      'wsl',
      'C:\\Users\\work\\shared-codex-home',
      {
        realpath: (value) => value,
        formatForAgent: () => '/mnt/c/Users/work/shared-codex-home',
        exec: async () => ({
          ok: true,
          exitCode: 0,
          stdout: `${distro}\n`,
          stderr: '',
          timedOut: false,
          durationMs: 1,
        }),
      },
    )
  );
  assert.notEqual(
    await mountedHomeIdentity('Ubuntu-24.04'),
    await mountedHomeIdentity('Debian'),
    'a shared Windows path is still owned by one specific WSL distribution',
  );
});

test('Agent Environment impact counts bound sessions without adopting legacy rows', async () => {
  const { inspectProviderHomeChange } = await import('@/lib/settings/provider-home-change');
  const impact = await inspectProviderHomeChange('managed-home-user', 'wsl', {
    resolveTargetIdentity: async (_userId, target) => `codex-home:${target}`,
    countUnavailable: dbSessions.countManagedCodexSessionsUnavailableInHome,
  });
  assert.deepEqual(impact, {
    targetProviderHomeIdentity: 'codex-home:wsl',
    unavailableManagedSessionCount: 2,
  });
  assert.equal(dbSessions.getSession('legacy')?.origin_provider_home_identity, null);
});
