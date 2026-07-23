import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexAccountEnvironment,
  resolveCodexAccountHome,
  writeCodexOverlayMarker,
} from '../src/lib/codex-home';

test('global Codex account lookup escapes a Tessera session overlay', () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'Users', 'test');
  const home = resolveCodexAccountHome({
    env: {
      CODEX_HOME: path.join(homeDir, '.tessera', 'codex-overlay', 'session-123'),
    },
    homeDir,
  });

  assert.equal(home, path.join(homeDir, '.codex'));
});

test('global Codex account lookup escapes a marked inherited overlay from another data root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-inherited-codex-overlay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const overlayHome = path.join(root, 'other-data', 'codex-overlay', 'session-123');
  const accountHome = path.join(homeDir, '.codex');
  fs.mkdirSync(overlayHome, { recursive: true });
  writeCodexOverlayMarker(overlayHome, accountHome);
  const home = resolveCodexAccountHome({
    env: {
      CODEX_HOME: overlayHome,
      TESSERA_DATA_DIR: path.join(root, 'isolated-tessera'),
    },
    homeDir,
  });

  assert.equal(home, accountHome);
});

test('an unmarked custom home below a codex-overlay directory is preserved', () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'Users', 'test');
  const customHome = path.join(path.parse(process.cwd()).root, 'accounts', 'codex-overlay', 'team');
  const home = resolveCodexAccountHome({
    env: { CODEX_HOME: customHome },
    homeDir,
  });

  assert.equal(home, customHome);
});

test('global Codex account lookup preserves a real custom home', () => {
  const homeDir = path.join(path.parse(process.cwd()).root, 'Users', 'test');
  const customHome = path.join(path.parse(process.cwd()).root, 'accounts', 'codex-work');
  const home = resolveCodexAccountHome({
    env: {
      CODEX_HOME: customHome,
    },
    homeDir,
  });

  assert.equal(home, customHome);
});

test('WSL account lookup leaves CODEX_HOME to the Linux login environment', () => {
  const env = buildCodexAccountEnvironment({
    CODEX_HOME: String.raw`C:\Users\test\.tessera\codex-overlay\session-123`,
    PATH: String.raw`C:\Windows\System32`,
  }, 'wsl');

  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.PATH, String.raw`C:\Windows\System32`);
});
