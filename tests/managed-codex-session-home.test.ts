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
        return { state: inspectionState };
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
