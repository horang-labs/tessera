import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COPY_BLOCK_CLOSE_MARKER,
  COPY_BLOCK_OPEN_MARKER,
} from '@/lib/projects/preparation-copy-block';
import {
  PREPARATION_BRANCH_NAME_ENV,
  PREPARATION_PROJECT_DIR_ENV,
  PREPARATION_WORKTREE_DIR_ENV,
} from '@/lib/projects/preparation-environment';
import { buildPreparationExecutionSpec } from '@/lib/projects/preparation-execution-spec';

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

const WINDOWS_GUARD = 'if errorlevel 1 exit /b %errorlevel%';

const posixContext = {
  projectDir: '/home/work/src/my-repo',
  worktreePath: '/home/work/.tessera/worktrees/my-repo/feature-0514-au',
  branchName: 'feature-0514-au',
  agentEnvironment: 'native' as const,
  runnerScriptDir: '/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera',
  env: { SHELL: '/bin/zsh' },
};

const windowsContext = {
  projectDir: 'C:\\Users\\work\\src\\my-repo',
  worktreePath: 'C:\\Users\\work\\.tessera\\worktrees\\my-repo\\feature-0514-au',
  branchName: 'feature-0514-au',
  agentEnvironment: 'native' as const,
  runnerScriptDir: 'C:\\Users\\work\\src\\my-repo\\.git\\worktrees\\feature-0514-au\\tessera',
  env: {},
};

const wslContext = {
  projectDir: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\src\\my-repo',
  worktreePath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.tessera\\worktrees\\my-repo\\feature-0514-au',
  branchName: 'feature-0514-au',
  agentEnvironment: 'wsl' as const,
  runnerScriptDir: '/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera',
  env: {},
};

test('a project with no preparation script gets no execution spec', () => {
  withPlatform('linux', () => {
    assert.equal(buildPreparationExecutionSpec({ ...posixContext, script: null }), null);
    assert.equal(buildPreparationExecutionSpec({ ...posixContext, script: '' }), null);
    assert.equal(buildPreparationExecutionSpec({ ...posixContext, script: '  \n\t\n ' }), null);
  });
});

test('Linux runs a runner script through the user shell in the worktree', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({
      ...posixContext,
      script: 'cp "$TESSERA_PROJECT_DIR/.env" .',
    });

    assert.ok(spec);
    assert.equal(spec.program, '/bin/zsh');
    assert.equal(spec.cwd, '/home/work/.tessera/worktrees/my-repo/feature-0514-au');
    assert.equal(spec.bridgedThroughWsl, false);
    assert.equal(
      spec.runnerScriptPath,
      '/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera/preparation-runner.sh',
    );
    assert.deepEqual(spec.args, ['-c', `exec bash '${spec.runnerScriptPath}'`]);
    assert.equal(
      spec.runnerScript,
      '#!/usr/bin/env bash\nset -e\ncd -- "$TESSERA_WORKTREE_DIR"\ncp "$TESSERA_PROJECT_DIR/.env" .\n',
    );
  });
});

test('macOS runs the runner through a login shell', () => {
  withPlatform('darwin', () => {
    const spec = buildPreparationExecutionSpec({ ...posixContext, script: 'npm ci' });

    assert.ok(spec);
    assert.equal(spec.program, '/bin/zsh');
    assert.deepEqual(spec.args.slice(0, 2), ['-l', '-c']);
  });
});

test('the shell falls back to a platform default when the host reports none', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({ ...posixContext, env: {}, script: 'true' });
    assert.ok(spec);
    assert.equal(spec.program, '/bin/bash');
  });

  withPlatform('darwin', () => {
    const spec = buildPreparationExecutionSpec({ ...posixContext, env: {}, script: 'true' });
    assert.ok(spec);
    assert.equal(spec.program, '/bin/zsh');
  });
});

test('the three context values reach the script as environment variables', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({ ...posixContext, script: 'true' });

    assert.ok(spec);
    assert.equal(spec.env[PREPARATION_PROJECT_DIR_ENV], '/home/work/src/my-repo');
    assert.equal(
      spec.env[PREPARATION_WORKTREE_DIR_ENV],
      '/home/work/.tessera/worktrees/my-repo/feature-0514-au',
    );
    assert.equal(spec.env[PREPARATION_BRANCH_NAME_ENV], 'feature-0514-au');
    assert.equal(spec.env.WSLENV, undefined);
  });
});

test('a POSIX runner stops at the first failing line', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({
      ...posixContext,
      script: 'echo one\nfalse\necho three',
    });

    assert.ok(spec);
    // `set -e` precedes every line the user wrote, so line 2 aborts before line 3.
    assert.ok(spec.runnerScript.startsWith('#!/usr/bin/env bash\nset -e\n'));
    assert.ok(spec.runnerScript.endsWith('echo one\nfalse\necho three\n'));
  });
});

test('Windows runs a batch runner that bails after each failing line', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({
      ...windowsContext,
      script: 'echo one\nnpm install\necho three',
    });

    assert.ok(spec);
    assert.equal(spec.program, 'cmd.exe');
    assert.equal(spec.cwd, 'C:\\Users\\work\\.tessera\\worktrees\\my-repo\\feature-0514-au');
    assert.equal(spec.bridgedThroughWsl, false);
    assert.equal(
      spec.runnerScriptPath,
      'C:\\Users\\work\\src\\my-repo\\.git\\worktrees\\feature-0514-au\\tessera\\preparation-runner.cmd',
    );
    assert.deepEqual(spec.args, ['/d', '/c', spec.runnerScriptPath]);

    // `call` is what returns control to the next line after npm.cmd and friends;
    // without it a batch command never comes back and later lines never run.
    assert.ok(spec.runnerScript.startsWith('@echo off\r\nsetlocal EnableExtensions\r\n'));
    assert.ok(spec.runnerScript.includes('cd /d "%TESSERA_WORKTREE_DIR%"\r\n'));
    assert.ok(spec.runnerScript.endsWith(
      `call echo one\r\n${WINDOWS_GUARD}\r\n`
      + `call npm install\r\n${WINDOWS_GUARD}\r\n`
      + `call echo three\r\n${WINDOWS_GUARD}\r\n`,
    ));
  });
});

test('the Windows runner keeps CRLF line endings throughout', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({
      ...windowsContext,
      script: 'echo one\n\necho two',
    });

    assert.ok(spec);
    assert.ok(!/[^\r]\n/.test(spec.runnerScript));
    // A blank line stays blank rather than becoming a guarded empty command.
    assert.equal(spec.runnerScript.split(WINDOWS_GUARD).length - 1, 2);
  });
});

test('the Windows runner treats a line starting with # as a comment', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({
      ...windowsContext,
      script: `${COPY_BLOCK_OPEN_MARKER}\ncp "$TESSERA_PROJECT_DIR/.env" .\n${COPY_BLOCK_CLOSE_MARKER}\n  # indented too\nnpm install`,
    });

    assert.ok(spec);
    // Markers have to read the same on every platform for a script to move
    // between machines, so batch learns the comment rather than the marker
    // changing shape.
    assert.ok(!spec.runnerScript.includes(`call ${COPY_BLOCK_OPEN_MARKER}`));
    assert.ok(!spec.runnerScript.includes(`call ${COPY_BLOCK_CLOSE_MARKER}`));
    assert.ok(!spec.runnerScript.includes('call # indented too'));
    // Only the comments are skipped; the commands between them still run.
    assert.ok(spec.runnerScript.includes(`call cp "$TESSERA_PROJECT_DIR/.env" .\r\n${WINDOWS_GUARD}\r\n`));
    assert.ok(spec.runnerScript.includes(`call npm install\r\n${WINDOWS_GUARD}\r\n`));
    assert.equal(spec.runnerScript.split(WINDOWS_GUARD).length - 1, 2);
  });
});

test('a script written with CRLF runs as POSIX line endings', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({
      ...posixContext,
      script: 'echo one\r\necho two',
    });

    assert.ok(spec);
    assert.ok(!spec.runnerScript.includes('\r'));
    assert.ok(spec.runnerScript.endsWith('echo one\necho two\n'));
  });
});

test('a Windows host with a WSL agent runs the runner inside the distro', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({
      ...wslContext,
      script: 'cp "$TESSERA_PROJECT_DIR/.env" .',
    });

    assert.ok(spec);
    assert.equal(spec.program, 'wsl.exe');
    assert.deepEqual(spec.args.slice(0, -1), ['-e', 'sh', '-c']);
    assert.equal(spec.bridgedThroughWsl, true);
    // Guest paths, not the UNC share the Windows host reaches them through.
    assert.equal(spec.cwd, '/home/work/.tessera/worktrees/my-repo/feature-0514-au');
    assert.equal(spec.env[PREPARATION_PROJECT_DIR_ENV], '/home/work/src/my-repo');
    assert.equal(
      spec.env[PREPARATION_WORKTREE_DIR_ENV],
      '/home/work/.tessera/worktrees/my-repo/feature-0514-au',
    );
    assert.equal(spec.env[PREPARATION_BRANCH_NAME_ENV], 'feature-0514-au');
    assert.equal(
      spec.runnerScriptPath,
      '/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera/preparation-runner.sh',
    );
    assert.ok(spec.runnerScript.startsWith('#!/usr/bin/env bash\nset -e\n'));

    const bridge = spec.args[spec.args.length - 1];
    // The user's tools have to be the ones their agents see, so the wrapper
    // hands the runner to their login shell rather than running it under `sh`.
    // Interactive too: ~/.bashrc and ~/.zshrc are where nvm and volta live.
    assert.ok(bridge.includes('exec "$shell" -l -i -c '));
    assert.ok(bridge.includes(spec.runnerScriptPath));
  });
});

test('the WSL bridge forwards the context values into the distro', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({ ...wslContext, script: 'true' });

    assert.ok(spec);
    // The values are already guest paths, so WSLENV must not apply /p translation.
    assert.equal(
      spec.env.WSLENV,
      `${PREPARATION_PROJECT_DIR_ENV}:${PREPARATION_WORKTREE_DIR_ENV}:${PREPARATION_BRANCH_NAME_ENV}`,
    );
  });
});

test('the WSL bridge keeps the variables the host already forwards', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({
      ...wslContext,
      script: 'true',
      env: { WSLENV: 'NODE_EXTRA_CA_CERTS/p:HTTPS_PROXY' },
    });

    assert.ok(spec);
    assert.equal(
      spec.env.WSLENV,
      'NODE_EXTRA_CA_CERTS/p:HTTPS_PROXY'
        + `:${PREPARATION_PROJECT_DIR_ENV}:${PREPARATION_WORKTREE_DIR_ENV}:${PREPARATION_BRANCH_NAME_ENV}`,
    );
  });
});

test('a WSL-hosted runtime needs no bridge', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({
      ...posixContext,
      agentEnvironment: 'wsl',
      script: 'true',
    });

    assert.ok(spec);
    assert.equal(spec.program, '/bin/zsh');
    assert.equal(spec.bridgedThroughWsl, false);
    assert.equal(spec.env.WSLENV, undefined);
  });
});

test('a runner directory named as a UNC share is respelled for the POSIX shell', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({
      ...posixContext,
      // What a WSL-hosted runtime gets back when git answers through the
      // Windows side of the CLI bridge.
      runnerScriptDir:
        '//wsl.localhost/Ubuntu-24.04/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera',
      script: 'true',
    });

    assert.ok(spec);
    assert.equal(
      spec.runnerScriptPath,
      '/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera/preparation-runner.sh',
    );
  });
});

test('a runner directory named as a guest path is respelled for Windows', () => {
  withPlatform('win32', () => {
    const spec = buildPreparationExecutionSpec({
      ...windowsContext,
      worktreePath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\worktrees\\feature-0514-au',
      runnerScriptDir: '/home/work/src/my-repo/.git/worktrees/feature-0514-au/tessera',
      script: 'true',
    });

    assert.ok(spec);
    assert.equal(
      spec.runnerScriptPath,
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\src\\my-repo\\.git\\worktrees\\feature-0514-au\\tessera\\preparation-runner.cmd',
    );
  });
});

test('a runner directory with a space survives the shell wrapping', () => {
  withPlatform('linux', () => {
    const spec = buildPreparationExecutionSpec({
      ...posixContext,
      runnerScriptDir: "/home/work/src/my repo/.git/o'brien",
      script: 'true',
    });

    assert.ok(spec);
    assert.equal(
      spec.args[spec.args.length - 1],
      `exec bash '/home/work/src/my repo/.git/o'\\''brien/preparation-runner.sh'`,
    );
  });
});
