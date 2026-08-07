import assert from 'node:assert/strict';
import test from 'node:test';
import { isRunningInWsl } from '@/lib/cli/cli-exec';
import { getSpawnCliCache } from '@/lib/cli/spawn-cli-cache';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import type { AgentEnvironment } from '@/lib/settings/types';

/**
 * The setting branch reads through the per-user cache in `spawn-cli-cache`.
 * Seeding it keeps these tests off `SettingsManager.load`, which would open the
 * real database.
 */
async function withConfiguredEnvironment<T>(
  userId: string,
  environment: AgentEnvironment,
  run: () => Promise<T>,
): Promise<T> {
  const cache = getSpawnCliCache();
  cache.agentEnvironmentByUserId.set(userId, environment);
  try {
    return await run();
  } finally {
    cache.agentEnvironmentByUserId.delete(userId);
  }
}

const REAL_PLATFORM = process.platform;

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
  }
}

test('the configured environment wins over what the path looks like', async () => {
  await withConfiguredEnvironment('user-wsl', 'wsl', async () => {
    // A Windows-looking working directory must not talk the resolver out of the
    // setting: `validateProjectEnvironment` already forbids the disagreement,
    // so the setting is the only source of truth here.
    assert.equal(
      await resolveGitEnvironment({ userId: 'user-wsl' }),
      'wsl',
    );
  });

  await withConfiguredEnvironment('user-native', 'native', async () => {
    assert.equal(
      await resolveGitEnvironment({ userId: 'user-native' }),
      'native',
    );
  });
});

test('a Windows-hosted WSL UNC path infers wsl on any platform', async () => {
  const paths = ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\repo'];

  await withPlatform('win32', async () => {
    assert.equal(await resolveGitEnvironment({ inferFromPaths: paths }), 'wsl');
  });

  assert.equal(await resolveGitEnvironment({ inferFromPaths: paths }), 'wsl');
});

test('a posix path infers wsl on a Windows server', async () => {
  // The old git-panel rule. A Windows server handed `/home/...` is looking at a
  // WSL worktree; running Windows git against it could only fail.
  await withPlatform('win32', async () => {
    assert.equal(
      await resolveGitEnvironment({ inferFromPaths: ['/home/work/repo'] }),
      'wsl',
    );
  });
});

test('a posix path infers wsl when the server itself runs inside WSL', async (t) => {
  if (!isRunningInWsl()) {
    t.skip('not running inside WSL — this rung cannot be exercised here');
    return;
  }

  // The old managed.ts rule. `native` here would spawn *Windows* binaries
  // (spawn-cli-runtime.ts:175), which cannot reach a distro-local worktree.
  assert.equal(
    await resolveGitEnvironment({ inferFromPaths: ['/home/work/repo'] }),
    'wsl',
  );
});

test('Windows paths infer native', async () => {
  await withPlatform('win32', async () => {
    assert.equal(
      await resolveGitEnvironment({ inferFromPaths: ['C:\\Users\\work\\repo'] }),
      'native',
    );
  });
});

test('a Windows drive mount infers native on the server that can see it', async (t) => {
  if (!isRunningInWsl()) {
    t.skip('not running inside WSL — /mnt/c only means anything here');
    return;
  }

  // /mnt/c is the Windows filesystem seen from WSL, not a distro-local path,
  // so a WSL server runs git against it natively. Only asserted on this
  // platform: a Windows server never sees a path in this form, and the
  // posix-path clause would (correctly, for that server) call it wsl.
  assert.equal(
    await resolveGitEnvironment({ inferFromPaths: ['/mnt/c/Users/work/repo'] }),
    'native',
  );
});

test('one WSL path among several is enough to infer wsl', async () => {
  // removeManagedWorktree weighs the project directory and the worktree path
  // together; either one being WSL settles it.
  await withPlatform('win32', async () => {
    assert.equal(
      await resolveGitEnvironment({
        inferFromPaths: ['C:\\Users\\work\\repo', '/home/work/.tessera/worktrees/x'],
      }),
      'wsl',
    );
  });
});

test('no paths to go on infers native', async () => {
  assert.equal(await resolveGitEnvironment({ inferFromPaths: [] }), 'native');
});
