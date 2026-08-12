import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProcessManager } from '../src/lib/cli/process-manager';
import type {
  ServerTransportMessage,
  SessionSpawnConfig,
} from '../src/lib/ws/message-types';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-pending-session-options-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

async function createThroughControlAndSendFromComposer(options: {
  creator: SessionSpawnConfig;
  composerDefaults: SessionSpawnConfig;
}) {
  await import('../src/lib/cli/providers/bootstrap');
  const [database, dbSessions, actions, processManagerModule] = await Promise.all([
    import('../src/lib/db/database'),
    import('../src/lib/db/sessions'),
    import('../src/lib/ws/server-session-actions'),
    import('../src/lib/cli/process-manager'),
  ]);
  await database.initDatabase();

  const processManager = processManagerModule.processManager;
  const originalGetProcess = processManager.getProcess;
  const originalResumeSession = processManager.resumeSession;
  const originalSendMessage = processManager.sendMessage;
  const launches: SessionSpawnConfig[] = [];
  const deliveredMessages: unknown[] = [];
  const serverMessages: ServerTransportMessage[] = [];
  const sendToUser = (_userId: string, message: ServerTransportMessage) => {
    serverMessages.push(message);
  };

  processManager.getProcess = () => undefined;
  processManager.resumeSession = async (
    ...args: Parameters<ProcessManager['resumeSession']>
  ) => {
    launches.push({
      model: args[5],
      reasoningEffort: args[6],
      serviceTier: args[7]?.serviceTier,
    });
    return args[0];
  };
  processManager.sendMessage = (_sessionId, content) => {
    deliveredMessages.push(content);
  };

  try {
    await actions.createSessionFromWebSocket({
      userId: 'electron-user',
      sendToUser,
      providerId: 'codex',
      workDir: testRoot,
      executionMode: 'gui',
      ...options.creator,
    });
    const created = serverMessages.find((message) => message.type === 'session_created');
    assert.ok(created && created.type === 'session_created');

    await actions.sendSessionMessageFromWebSocket({
      userId: 'electron-user',
      sendToUser,
      sessionId: created.sessionId,
      content: 'First message from the normal Electron composer',
      spawnConfig: options.composerDefaults,
    });

    const started = serverMessages.find((message) => message.type === 'session_started');
    assert.ok(started && started.type === 'session_started');
    assert.deepEqual(deliveredMessages, ['First message from the normal Electron composer']);
    return {
      launches,
      started,
      stored: dbSessions.getSession(created.sessionId),
    };
  } finally {
    processManager.getProcess = originalGetProcess;
    processManager.resumeSession = originalResumeSession;
    processManager.sendMessage = originalSendMessage;
  }
}

test('control-created pending Codex options outrank composer defaults on first send', async () => {
  const result = await createThroughControlAndSendFromComposer({
    creator: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'fast',
    },
    composerDefaults: {
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'low',
      serviceTier: 'default',
    },
  });
  const expected = {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    serviceTier: 'fast',
  };

  assert.deepEqual(result.launches, [expected]);
  assert.deepEqual({
    model: result.started.model,
    reasoningEffort: result.started.reasoningEffort,
    serviceTier: result.started.serviceTier,
  }, expected);
  assert.deepEqual({
    model: result.stored?.model,
    reasoningEffort: result.stored?.reasoning_effort,
    serviceTier: result.stored?.service_tier,
  }, expected);
});

test('composer defaults fill only options omitted by a control-created pending Codex session', async () => {
  const result = await createThroughControlAndSendFromComposer({
    creator: { model: 'gpt-5.6-sol' },
    composerDefaults: {
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'low',
      serviceTier: 'default',
    },
  });
  const expected = {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'low',
    serviceTier: 'default',
  };

  assert.deepEqual(result.launches, [expected]);
  assert.deepEqual({
    model: result.started.model,
    reasoningEffort: result.started.reasoningEffort,
    serviceTier: result.started.serviceTier,
  }, expected);
  assert.deepEqual({
    model: result.stored?.model,
    reasoningEffort: result.stored?.reasoning_effort,
    serviceTier: result.stored?.service_tier,
  }, expected);
});
