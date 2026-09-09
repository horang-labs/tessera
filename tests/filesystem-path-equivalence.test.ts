import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areCrossEnvironmentFilesystemPathsEquivalent,
  crossEnvironmentFilesystemPathKey,
} from '@/lib/filesystem/path-equivalence';

test('Windows-hosted WSL UNC and agent POSIX paths share one comparison key', () => {
  const unc = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev';
  const legacyUnc = '\\\\wsl$\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev';
  const agentPath = '/home/work/Source/tessera-dev';

  assert.equal(crossEnvironmentFilesystemPathKey(unc), `wsl:${agentPath}`);
  assert.equal(areCrossEnvironmentFilesystemPathsEquivalent(unc, agentPath), true);
  assert.equal(areCrossEnvironmentFilesystemPathsEquivalent(legacyUnc, agentPath), true);
});

test('Windows drive and WSL mount spellings compare case-insensitively', () => {
  assert.equal(
    areCrossEnvironmentFilesystemPathsEquivalent(
      'C:\\Users\\work\\Source\\tessera-dev',
      '/mnt/c/users/WORK/source/tessera-dev',
    ),
    true,
  );
});

test('distinct WSL paths remain distinct', () => {
  assert.equal(
    areCrossEnvironmentFilesystemPathsEquivalent(
      '/home/work/Source/tessera-dev',
      '/home/work/Source/tessera-main',
    ),
    false,
  );
});
