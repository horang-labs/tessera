import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWslOpenCodeOverlayCreateScript,
  readWslOpenCodeOverlayReport,
} from '@/lib/terminal/opencode-overlay-wsl';

function runScript(script: string, home: string): string {
  return execFileSync('sh', ['-s'], {
    input: script,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

test('WSL OpenCode overlay stays guest-native and preserves installed dependencies', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-wsl-opencode-overlay-'));
  const firstPlugin = 'export const TesseraLifecyclePlugin = async () => ({ event() {} });\n';
  const secondPlugin = `${firstPlugin}// refreshed\n`;

  try {
    const firstStdout = runScript(buildWslOpenCodeOverlayCreateScript(b64(firstPlugin)), home);
    const overlay = readWslOpenCodeOverlayReport(firstStdout);
    assert.equal(overlay, path.join(home, '.tessera/opencode-overlay/shared'));
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'plugins/tessera-lifecycle.js'), 'utf8'),
      firstPlugin,
    );

    // OpenCode owns these runtime files. Preparing a later PTY must not remove
    // them, otherwise every session pays the plugin dependency install again.
    const dependencyMarker = path.join(overlay!, 'node_modules/@opencode-ai/plugin/installed');
    const packageJson = path.join(overlay!, 'package.json');
    const bunLock = path.join(overlay!, 'bun.lock');
    fs.mkdirSync(path.dirname(dependencyMarker), { recursive: true });
    fs.writeFileSync(dependencyMarker, 'cached');
    fs.writeFileSync(packageJson, '{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}\n');
    fs.writeFileSync(bunLock, 'cached-lock');

    const secondStdout = runScript(buildWslOpenCodeOverlayCreateScript(b64(secondPlugin)), home);
    assert.equal(readWslOpenCodeOverlayReport(secondStdout), overlay);
    assert.equal(fs.readFileSync(dependencyMarker, 'utf8'), 'cached');
    assert.equal(
      fs.readFileSync(packageJson, 'utf8'),
      '{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}\n',
    );
    assert.equal(fs.readFileSync(bunLock, 'utf8'), 'cached-lock');
    assert.equal(
      fs.readFileSync(path.join(overlay!, 'plugins/tessera-lifecycle.js'), 'utf8'),
      secondPlugin,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL OpenCode overlay script rejects malformed plugin payloads', () => {
  assert.throws(() => buildWslOpenCodeOverlayCreateScript("'; rm -rf /"));
});
