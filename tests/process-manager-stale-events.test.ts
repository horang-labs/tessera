import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { ProcessInfo } from '@/lib/cli/types';
import { attachManagedProcessHandlers } from '@/lib/cli/process-manager-runtime';

function mockProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return emitter;
}

test('late events from a replaced process cannot mutate the newly registered runtime', () => {
  const oldProcess = mockProcess();
  const newProcess = mockProcess();
  const processes = new Map<string, ProcessInfo>();
  processes.set('session-1', { process: oldProcess } as ProcessInfo);
  let stdoutRoutes = 0;
  let exits = 0;
  let errors = 0;
  attachManagedProcessHandlers({
    processes,
    sessionId: 'session-1',
    userId: 'user-1',
    cliProcess: oldProcess,
    routeStdoutLine: () => { stdoutRoutes += 1; },
    handleProcessExit: () => { exits += 1; },
    handleProcessError: () => { errors += 1; },
  });

  processes.set('session-1', { process: newProcess } as ProcessInfo);
  oldProcess.stdout?.emit('data', Buffer.from('stale output\n'));
  oldProcess.emit('error', new Error('late error'));
  oldProcess.emit('exit', 0, null);

  assert.equal(stdoutRoutes, 0);
  assert.equal(errors, 0);
  assert.equal(exits, 0);
  assert.equal(processes.get('session-1')?.process, newProcess);
});
