import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isRunningInWsl, type ExecResult } from '@/lib/cli/cli-exec';
import { inspectCodexManagedSessionResume } from '@/lib/cli/providers/codex/managed-session';
import {
  isCodexRolloutOpenByAnotherRuntime,
  watchCodexRolloutRuntimeOwners,
} from '@/lib/cli/providers/codex/provider-runtime-ownership';

const CLOSED_PROBE: ExecResult = {
  ok: true,
  exitCode: 0,
  stdout: '0\n',
  stderr: '',
  timedOut: false,
  durationMs: 1,
};

test('durable rollout presence and a real external file owner gate managed resume', async () => {
  const providerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-runtime-owner-'));
  const providerSessionId = 'thread-owned-runtime';
  const rolloutDir = path.join(providerHome, 'sessions', '2026', '08', '12');
  const rolloutPath = path.join(rolloutDir, `rollout-now-${providerSessionId}.jsonl`);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');

  const context = {
    environment: isRunningInWsl() ? 'wsl' as const : 'native' as const,
    providerHomeFilesystemPath: providerHome,
  };
  const holder = spawn(process.execPath, [
    '-e',
    `const fs=require('node:fs');fs.openSync(process.argv[1],'a');process.stdout.write('ready\\n');setInterval(()=>{},1000)`,
    rolloutPath,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  try {
    await once(holder.stdout!, 'data');
    assert.deepEqual(
      await inspectCodexManagedSessionResume(context, providerSessionId),
      {
        state: 'unavailable',
        reason: 'provider-session-already-running',
        message: 'This provider conversation is already open in another runtime. Fork it to work in parallel.',
      },
    );

    holder.kill('SIGTERM');
    await once(holder, 'close');
    const available = await inspectCodexManagedSessionResume(context, providerSessionId);
    assert.equal(available.state, 'available');
    assert.equal(typeof available.runtimeGuard?.reinspect, 'function');
    assert.deepEqual(
      await inspectCodexManagedSessionResume(context, 'thread-missing-runtime'),
      {
        state: 'unavailable',
        reason: 'provider-history-missing',
        message: 'The provider conversation is missing from its origin home. Tessera kept the management record but cannot resume it.',
      },
    );
  } finally {
    if (holder.exitCode === null) holder.kill('SIGTERM');
    fs.rmSync(providerHome, { recursive: true, force: true });
  }
});

test('managed runtime monitor stops the inside-first ordering when a second owner appears', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-runtime-monitor-'));
  const rolloutPath = path.join(testDir, 'rollout.jsonl');
  fs.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
  const environment = isRunningInWsl() ? 'wsl' as const : 'native' as const;
  const holders: ReturnType<typeof spawn>[] = [];
  const spawnHolder = async () => {
    const holder = spawn(process.execPath, [
      '-e',
      `const fs=require('node:fs');fs.openSync(process.argv[1],'a');process.stdout.write('ready\\n');setInterval(()=>{},1000)`,
      rolloutPath,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    holders.push(holder);
    await once(holder.stdout!, 'data');
    return holder;
  };

  try {
    await spawnHolder();
    let resolveConflict!: (message: string) => void;
    const conflict = new Promise<string>((resolve) => { resolveConflict = resolve; });
    const dispose = await watchCodexRolloutRuntimeOwners(
      rolloutPath,
      environment,
      resolveConflict,
      { pollIntervalMs: 20 },
    );
    await spawnHolder();
    assert.match(await conflict, /opened by another runtime/u);
    dispose();
  } finally {
    for (const holder of holders) {
      if (holder.exitCode === null) holder.kill('SIGTERM');
    }
    await Promise.all(holders.map(async (holder) => {
      if (holder.exitCode === null) await once(holder, 'close');
    }));
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('runtime ownership probes execute in the provider Agent Environment', async () => {
  const calls: Array<{ command: string; args: string[]; environment: 'native' | 'wsl' }> = [];
  const exec = async (command: string, args: string[], environment: 'native' | 'wsl') => {
    calls.push({ command, args, environment });
    return command === 'lsof'
      ? { ...CLOSED_PROBE, ok: false, exitCode: 1 }
      : CLOSED_PROBE;
  };

  assert.equal(await isCodexRolloutOpenByAnotherRuntime(
    'C:\\Users\\work\\.codex\\sessions\\rollout.jsonl',
    'native',
    {
      exec,
      runtimePlatform: () => 'win32',
      runningInWsl: () => false,
      formatForAgent: (value) => value,
    },
  ), false);
  const nativeWindows = calls.pop();
  assert.equal(nativeWindows?.command, 'powershell.exe');
  assert.equal(nativeWindows?.environment, 'native');
  assert.equal(nativeWindows?.args.at(-1), 'C:\\Users\\work\\.codex\\sessions\\rollout.jsonl');

  assert.equal(await isCodexRolloutOpenByAnotherRuntime(
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.codex\\sessions\\rollout.jsonl',
    'wsl',
    {
      exec,
      runtimePlatform: () => 'win32',
      runningInWsl: () => false,
      formatForAgent: () => '/home/work/.codex/sessions/rollout.jsonl',
    },
  ), false);
  const bridgedWsl = calls.pop();
  assert.equal(bridgedWsl?.command, 'sh');
  assert.equal(bridgedWsl?.environment, 'wsl');
  assert.equal(bridgedWsl?.args.at(-1), '/home/work/.codex/sessions/rollout.jsonl');

  assert.equal(await isCodexRolloutOpenByAnotherRuntime(
    '/mnt/c/Users/work/.codex/sessions/rollout.jsonl',
    'native',
    {
      exec,
      runtimePlatform: () => 'linux',
      runningInWsl: () => true,
      formatForAgent: () => 'C:\\Users\\work\\.codex\\sessions\\rollout.jsonl',
    },
  ), false);
  const wslHostedNative = calls.pop();
  assert.equal(wslHostedNative?.command, 'powershell.exe');
  assert.equal(wslHostedNative?.environment, 'native');
  assert.equal(wslHostedNative?.args.at(-1), 'C:\\Users\\work\\.codex\\sessions\\rollout.jsonl');

  assert.equal(await isCodexRolloutOpenByAnotherRuntime(
    '/Users/work/.codex/sessions/rollout.jsonl',
    'native',
    {
      exec,
      runtimePlatform: () => 'darwin',
      runningInWsl: () => false,
      formatForAgent: (value) => value,
    },
  ), false);
  const macNative = calls.pop();
  assert.equal(macNative?.command, 'lsof');
  assert.equal(macNative?.environment, 'native');
  assert.equal(macNative?.args.at(-1), '/Users/work/.codex/sessions/rollout.jsonl');
});
