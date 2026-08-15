import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a failed terminal probe is never reported or cached as all not installed', {
  skip: process.platform === 'win32',
}, async () => {
  const originalShell = process.env.SHELL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-probe-'));
  const failingShell = path.join(root, 'failing-shell');
  const successfulShell = path.join(root, 'successful-shell');
  fs.writeFileSync(failingShell, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  fs.writeFileSync(
    successfulShell,
    "#!/bin/sh\nprintf 'claude\\t/fake/claude\\ncodex\\t/fake/codex\\nopencode\\t/fake/opencode\\n'\n",
    { mode: 0o700 },
  );

  try {
    const detection = await import('@/lib/terminal/provider-detection');
    detection.invalidateTerminalProviderDetection();
    process.env.SHELL = failingShell;

    await assert.rejects(
      detection.detectTerminalProviders({ force: true, environment: 'native' }),
      /probe failed/,
    );

    process.env.SHELL = successfulShell;
    const lastSuccessful = await detection.detectTerminalProviders({
      force: true,
      environment: 'native',
    });
    assert.equal(lastSuccessful.some((provider) => provider.installed), true);
    process.env.SHELL = failingShell;
    const afterFailure = await detection.detectTerminalProviders({
      force: true,
      environment: 'native',
    });

    assert.deepEqual(afterFailure, lastSuccessful);
  } finally {
    process.env.SHELL = originalShell;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
