import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { CliProvider, SpawnOptions } from '@/lib/cli/providers/types';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { ProcessManager } from '@/lib/cli/process-manager';
import { protocolAdapter } from '@/lib/cli/protocol-adapter';

function mockProcess(): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  Object.assign(process, {
    pid: 4321,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return process;
}

test('registering a managed skill overlay invalidates pre-launch skill discovery', () => {
  const messages: ServerTransportMessage[] = [];
  protocolAdapter.setSendToUser((_userId, message) => messages.push(message));
  const manager = new ProcessManager();
  const provider = {
    getDisplayName: () => 'Test provider',
  } as unknown as CliProvider;
  const spawnOptions = {
    managedLaunch: {
      environment: {},
      guestEnvironment: {},
      skillOverlay: {
        rootDir: '/tmp/tessera-plugin',
        skillsDir: '/tmp/tessera-skills',
      },
    },
  } as SpawnOptions;

  try {
    const register = manager as unknown as {
      registerRunningProcess(
        sessionId: string,
        userId: string,
        provider: CliProvider,
        cliProcess: ChildProcess,
        options: SpawnOptions,
        lifecycle: 'spawned' | 'resumed',
      ): void;
    };
    register.registerRunningProcess(
      'session-1',
      'user-1',
      provider,
      mockProcess(),
      spawnOptions,
      'spawned',
    );

    assert.deepEqual(messages, [{ type: 'skills_changed', sessionId: 'session-1' }]);
  } finally {
    protocolAdapter.setSendToUser(() => undefined);
  }
});
