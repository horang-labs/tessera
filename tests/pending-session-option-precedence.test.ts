import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProcessManager } from '../src/lib/cli/process-manager';
import type { CliProvider } from '../src/lib/cli/providers/types';
import type { SpawnOptions } from '../src/lib/cli/types';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-pending-session-options-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('API-created pending Codex options take precedence over composer defaults on first launch', async () => {
  await import('../src/lib/cli/providers/bootstrap');
  const [{ initDatabase }, { getSession }, { persistCreatedSessionRecord }, { SessionOrchestrator }] =
    await Promise.all([
      import('../src/lib/db/database'),
      import('../src/lib/db/sessions'),
      import('../src/lib/session/session-persistence'),
      import('../src/lib/session/session-orchestrator'),
    ]);
  await initDatabase();

  const sessionId = 'api-created-pending-codex';
  persistCreatedSessionRecord({
    sessionId,
    resolvedWorkDir: testRoot,
    title: 'API-created pending Codex',
    providerId: 'codex',
    executionMode: 'gui',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'fast',
  });

  const launches: Array<{
    model?: string;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
  }> = [];
  const processManager = {
    async resumeSession(
      _sessionId: string,
      _userId: string,
      _provider: CliProvider,
      _workDir?: string,
      _permissionMode?: string,
      model?: string,
      reasoningEffort?: string | null,
      extraSpawnOptions?: Partial<SpawnOptions>,
    ) {
      launches.push({
        model,
        reasoningEffort,
        serviceTier: extraSpawnOptions?.serviceTier,
      });
      return sessionId;
    },
  } as unknown as ProcessManager;
  const orchestrator = new SessionOrchestrator(processManager);

  const started = await orchestrator.resumeSession('electron-user', sessionId, {
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'low',
    serviceTier: 'default',
  });

  assert.deepEqual(launches, [{
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'fast',
  }]);
  assert.deepEqual(
    {
      model: started.model,
      reasoningEffort: started.reasoningEffort,
      serviceTier: started.serviceTier,
    },
    launches[0],
  );
  assert.deepEqual(
    {
      model: getSession(sessionId)?.model,
      reasoningEffort: getSession(sessionId)?.reasoning_effort,
      serviceTier: getSession(sessionId)?.service_tier,
    },
    launches[0],
  );
});

test('composer defaults fill only omitted pending Codex options and become the stored launch config', async () => {
  await import('../src/lib/cli/providers/bootstrap');
  const [{ initDatabase }, { getSession }, { persistCreatedSessionRecord }, { SessionOrchestrator }] =
    await Promise.all([
      import('../src/lib/db/database'),
      import('../src/lib/db/sessions'),
      import('../src/lib/session/session-persistence'),
      import('../src/lib/session/session-orchestrator'),
    ]);
  await initDatabase();

  const sessionId = 'api-created-partial-codex';
  persistCreatedSessionRecord({
    sessionId,
    resolvedWorkDir: testRoot,
    title: 'API-created partial Codex',
    providerId: 'codex',
    executionMode: 'gui',
    model: 'gpt-5.6-sol',
  });

  const launches: Array<{
    model?: string;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
  }> = [];
  const processManager = {
    async resumeSession(
      _sessionId: string,
      _userId: string,
      _provider: CliProvider,
      _workDir?: string,
      _permissionMode?: string,
      model?: string,
      reasoningEffort?: string | null,
      extraSpawnOptions?: Partial<SpawnOptions>,
    ) {
      launches.push({
        model,
        reasoningEffort,
        serviceTier: extraSpawnOptions?.serviceTier,
      });
      return sessionId;
    },
  } as unknown as ProcessManager;
  const orchestrator = new SessionOrchestrator(processManager);

  const started = await orchestrator.resumeSession('electron-user', sessionId, {
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'low',
    serviceTier: 'default',
  });

  assert.deepEqual(launches, [{
    model: 'gpt-5.6-sol',
    reasoningEffort: 'low',
    serviceTier: 'default',
  }]);
  assert.deepEqual(
    {
      model: started.model,
      reasoningEffort: started.reasoningEffort,
      serviceTier: started.serviceTier,
    },
    launches[0],
  );
  assert.deepEqual(
    {
      model: getSession(sessionId)?.model,
      reasoningEffort: getSession(sessionId)?.reasoning_effort,
      serviceTier: getSession(sessionId)?.service_tier,
    },
    launches[0],
  );
});
