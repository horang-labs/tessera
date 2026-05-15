import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManagedWorktreePathTemplate } from '../src/lib/worktrees/path-template-server';

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
}

test('Windows-hosted WSL mode preserves explicit WSL UNC worktree templates', () => {
  withPlatform('win32', () => {
    const result = resolveManagedWorktreePathTemplate(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.tessera\\worktrees_from_elec\\{projectSlug}\\{branchName}',
      {
        agentEnvironment: 'wsl',
        branchName: 'feature-0514-au',
        projectDir: '/home/work/src/my-repo',
      },
    );

    assert.equal(
      result,
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.tessera\\worktrees_from_elec\\my-repo\\feature-0514-au',
    );
  });
});

test('Windows-hosted WSL mode keeps POSIX WSL worktree templates as POSIX paths', () => {
  withPlatform('win32', () => {
    const result = resolveManagedWorktreePathTemplate(
      '/home/work/.tessera/worktrees_from_elec/{projectSlug}/{branchName}',
      {
        agentEnvironment: 'wsl',
        branchName: 'feature-0514-au',
        projectDir: '/home/work/src/my-repo',
      },
    );

    assert.equal(
      result,
      '/home/work/.tessera/worktrees_from_elec/my-repo/feature-0514-au',
    );
  });
});

test('WSL-hosted runtime keeps existing UNC template normalization to POSIX paths', () => {
  withPlatform('linux', () => {
    const result = resolveManagedWorktreePathTemplate(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.tessera\\worktrees_from_elec\\{projectSlug}\\{branchName}',
      {
        agentEnvironment: 'wsl',
        branchName: 'feature-0514-au',
        projectDir: '/home/work/src/my-repo',
      },
    );

    assert.equal(
      result,
      '/home/work/.tessera/worktrees_from_elec/my-repo/feature-0514-au',
    );
  });
});

test('native Windows worktree templates keep Windows drive paths', () => {
  withPlatform('win32', () => {
    const result = resolveManagedWorktreePathTemplate(
      'C:\\Users\\work\\.tessera\\worktrees\\{projectSlug}\\{branchName}',
      {
        agentEnvironment: 'native',
        branchName: 'feature-0514-au',
        projectDir: 'C:\\Users\\work\\src\\my-repo',
      },
    );

    assert.equal(
      result,
      'C:\\Users\\work\\.tessera\\worktrees\\my-repo\\feature-0514-au',
    );
  });
});

test('WSL UNC projects still normalize POSIX templates to the project UNC style', () => {
  withPlatform('win32', () => {
    const result = resolveManagedWorktreePathTemplate(
      '/home/work/.tessera/worktrees_from_elec/{projectSlug}/{branchName}',
      {
        agentEnvironment: 'wsl',
        branchName: 'feature-0514-au',
        projectDir: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\src\\my-repo',
      },
    );

    assert.equal(
      result,
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.tessera\\worktrees_from_elec\\my-repo\\feature-0514-au',
    );
  });
});

test('WSL UNC templates still validate against POSIX WSL project paths', () => {
  withPlatform('win32', () => {
    assert.throws(
      () => resolveManagedWorktreePathTemplate(
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\src\\{branchName}',
        {
          agentEnvironment: 'wsl',
          branchName: 'my-repo',
          projectDir: '/home/work/src/my-repo',
        },
      ),
      /source project directory/,
    );
  });
});
