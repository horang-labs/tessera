import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { loadCodexSkills } from '../src/lib/chat/codex-skill-loader';
import { CodexAdapter } from '../src/lib/cli/providers/codex/adapter';
import { CodexProtocolParser } from '../src/lib/cli/providers/codex/protocol-parser';
import { handleIncomingServerMessage } from '../src/lib/ws/client-message-handlers';
import { useCommandStore } from '../src/stores/command-store';

function createMockProcess(): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return {
    stdin,
    stdout,
    stderr,
    on: stdout.on.bind(stdout),
    once: stdout.once.bind(stdout),
    removeListener: stdout.removeListener.bind(stdout),
  } as unknown as ChildProcess;
}

test('Codex skill discovery requests the active working directory and forces a rescan', async () => {
  const adapter = new CodexAdapter();
  const proc = createMockProcess();
  const writes: string[] = [];
  proc.stdin?.on('data', (chunk) => writes.push(chunk.toString()));

  const adapterInternals = adapter as unknown as {
    _processRuntimeConfig: WeakMap<ChildProcess, { cwd: string }>;
    _awaitResponse: () => Promise<{
      id: number;
      result: {
        data: Array<{
          cwd: string;
          errors: unknown[];
          skills: Array<{
            name: string;
            description: string;
            path: string;
            scope: string;
            enabled: boolean;
          }>;
        }>;
      };
    }>;
  };
  adapterInternals._processRuntimeConfig.set(proc, { cwd: '/workspace/project' });
  adapterInternals._awaitResponse = async () => ({
    id: 3,
    result: {
      data: [{
        cwd: '/workspace/project',
        errors: [],
        skills: [{
          name: 'ask-matt',
          description: 'Ask Matt',
          path: '/home/work/.agents/skills/ask-matt/SKILL.md',
          scope: 'user',
          enabled: true,
        }],
      }],
    },
  });

  const skills = await adapter.createSkillSource('session-1', proc)?.listSkills();

  assert.equal(skills?.[0]?.name, 'ask-matt');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]), {
    jsonrpc: '2.0',
    id: 3,
    method: 'skills/list',
    params: {
      cwds: ['/workspace/project'],
      forceReload: true,
    },
  });
});

test('Codex skills/changed notification invalidates the client skill cache', () => {
  const parser = new CodexProtocolParser();

  assert.deepEqual(
    parser.parseStdout('session-1', JSON.stringify({
      jsonrpc: '2.0',
      method: 'skills/changed',
      params: {},
    })),
    [{
      serverMessage: {
        type: 'skills_changed',
        sessionId: 'session-1',
      },
    }],
  );
});

test('skills_changed clears a loaded list and advances its reload revision', () => {
  useCommandStore.getState().setCommands('session-1', [{
    name: 'stale-skill',
    description: 'Stale',
  }]);
  const previousRevision = useCommandStore.getState().revisions['session-1'] ?? 0;

  handleIncomingServerMessage({
    msg: {
      type: 'skills_changed',
      sessionId: 'session-1',
    },
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    wasReconnect: false,
  });

  assert.equal(useCommandStore.getState().commands['session-1'], undefined);
  assert.equal(
    useCommandStore.getState().revisions['session-1'],
    previousRevision + 1,
  );
  useCommandStore.getState().clearSession('session-1');
});

test('Codex skill loading retries a temporary unavailable response without caching empty', async () => {
  const statuses = [503, 200];
  const delays: number[] = [];

  const skills = await loadCodexSkills('session-1', {
    fetcher: async () => {
      const status = statuses.shift() ?? 500;
      return new Response(
        JSON.stringify(status === 200
          ? { skills: [{ name: 'ask-matt', description: 'Ask Matt' }] }
          : { error: 'not ready', retryable: true }),
        {
          status,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    retryDelaysMs: [25],
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.deepEqual(delays, [25]);
  assert.deepEqual(skills, [{ name: 'ask-matt', description: 'Ask Matt' }]);
});

test('Codex skill loading retries a malformed success payload instead of caching empty', async () => {
  const payloads = [{ pending: true }, { skills: [] }];
  let waitCount = 0;

  const skills = await loadCodexSkills('session-1', {
    fetcher: async () => new Response(
      JSON.stringify(payloads.shift()),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
    retryDelaysMs: [0],
    wait: async () => {
      waitCount += 1;
    },
  });

  assert.equal(waitCount, 1);
  assert.deepEqual(skills, []);
});

test('Codex skill discovery surfaces RPC failures instead of reporting a valid empty list', async () => {
  const adapter = new CodexAdapter();
  const proc = createMockProcess();
  const adapterInternals = adapter as unknown as {
    _processThreadIds: WeakMap<ChildProcess, string>;
    _processRuntimeConfig: WeakMap<ChildProcess, { cwd: string }>;
    _awaitResponse: () => Promise<never>;
  };
  adapterInternals._processThreadIds.set(proc, 'thread-1');
  adapterInternals._processRuntimeConfig.set(proc, { cwd: '/workspace/project' });
  adapterInternals._awaitResponse = async () => {
    throw new Error('temporary RPC failure');
  };

  await assert.rejects(
    adapter.createSkillSource('session-1', proc)?.listSkills(),
    /temporary RPC failure/,
  );
});
