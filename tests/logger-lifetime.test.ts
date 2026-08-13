import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('the Node test logger writes debug output without keeping its process alive', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "const loaded = await import('./src/lib/logger.ts'); loaded.default.default.debug('logger lifetime probe');",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOG_LEVEL: 'debug',
        NODE_TEST_CONTEXT: 'child-v8',
      },
      timeout: 2_000,
    },
  );

  assert.match(stdout, /logger lifetime probe/);
});

test('the process manager health check does not own the process lifetime', async () => {
  await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "await import('./src/lib/cli/process-manager.ts');",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: 'child-v8',
      },
      timeout: 2_000,
    },
  );
});
